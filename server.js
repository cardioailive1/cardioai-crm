'use strict';

/*
 * Cardio AI CRM Pro — server
 *
 * - Employees sign in with their Google Workspace account.
 * - Access is restricted to an approved email domain (and/or an explicit
 *   allow-list) so only your team can reach the platform.
 * - The full CRM single-page app is served only to signed-in users.
 * - A protected REST API backs the dynamic data (contacts, deals, tasks,
 *   notifications, activities, sequences) and persists it to Postgres.
 * - The AI Assistant is proxied server-side so the Anthropic API key is
 *   never exposed to the browser.
 *
 * Mirrors the Cardio AI Operations platform. Deploys on Render.com as a
 * single Node web service plus a managed Postgres database.
 */

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const helmet = require('helmet');
const compression = require('compression');
const morgan = require('morgan');

const { createStore, COLLECTIONS } = require('./storage');
const integrations = require('./integrations');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || 'development';
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

const BASE_URL =
  process.env.BASE_URL ||
  (process.env.RENDER_EXTERNAL_URL
    ? process.env.RENDER_EXTERNAL_URL
    : `http://localhost:${PORT}`);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_CALLBACK_URL =
  process.env.GOOGLE_CALLBACK_URL || `${BASE_URL}/auth/google/callback`;

const ALLOWED_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAIN || 'cardioailive.com')
  .split(',')
  .map((d) => d.trim().toLowerCase())
  .filter(Boolean);

const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || '')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
const store = createStore();

// ---------------------------------------------------------------------------
// Passport / Google OAuth
// ---------------------------------------------------------------------------
function emailIsAllowed(email) {
  if (!email) return false;
  const lower = email.toLowerCase();
  if (ALLOWED_EMAILS.includes(lower)) return true;
  const domain = lower.split('@')[1] || '';
  return ALLOWED_DOMAINS.includes(domain);
}

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(
    new GoogleStrategy(
      {
        clientID: GOOGLE_CLIENT_ID,
        clientSecret: GOOGLE_CLIENT_SECRET,
        callbackURL: GOOGLE_CALLBACK_URL,
      },
      (accessToken, refreshToken, profile, done) => {
        const email =
          profile.emails && profile.emails[0] && profile.emails[0].value;
        if (!emailIsAllowed(email)) {
          return done(null, false, { message: 'domain_not_allowed' });
        }
        const user = {
          id: profile.id,
          email,
          name: profile.displayName || email,
          picture:
            profile.photos && profile.photos[0]
              ? profile.photos[0].value
              : null,
        };
        return done(null, user);
      }
    )
  );
} else {
  console.warn(
    '[auth] GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set — Google sign-in ' +
      'is disabled until you configure them. See .env.example and README.md.'
  );
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

// ---------------------------------------------------------------------------
// App + middleware
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1); // required for secure cookies behind Render's proxy

app.use(
  helmet({
    // The SPA is a single self-contained HTML file using inline styles/scripts
    // plus a couple of CDNs (Chart.js, Google Fonts). Disable CSP rather than
    // ship a broken policy; tighten later if you externalize assets.
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(compression());
app.use(morgan(NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));

// Session store: Postgres-backed when available, else file-backed for dev.
let sessionStore;
if (store.driver === 'postgres') {
  const pgSession = require('connect-pg-simple')(session);
  sessionStore = new pgSession({
    pool: store._pool,
    tableName: 'session',
    createTableIfMissing: true,
  });
} else {
  const FileStore = require('session-file-store')(session);
  sessionStore = new FileStore({
    path: path.join(__dirname, '.sessions'),
    retries: 1,
    logFn: () => {},
  });
}

app.use(
  session({
    store: sessionStore,
    name: 'cardioai.sid',
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: NODE_ENV === 'production',
      maxAge: 1000 * 60 * 60 * 12, // 12 hours
    },
  })
);

app.use(passport.initialize());
app.use(passport.session());

// ---------------------------------------------------------------------------
// Auth routes
// ---------------------------------------------------------------------------
app.get('/auth/google', (req, res, next) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return res.redirect('/login?error=google_not_configured');
  }
  return passport.authenticate('google', {
    scope: ['profile', 'email'],
    prompt: 'select_account',
    hd: ALLOWED_DOMAINS[0],
  })(req, res, next);
});

app.get('/auth/google/callback', (req, res, next) => {
  passport.authenticate('google', (err, user, info) => {
    if (err) return next(err);
    if (!user) {
      const reason = (info && info.message) || 'sign_in_failed';
      return res.redirect(`/login?error=${encodeURIComponent(reason)}`);
    }
    req.logIn(user, (loginErr) => {
      if (loginErr) return next(loginErr);
      return res.redirect('/');
    });
  })(req, res, next);
});

app.get('/auth/logout', (req, res, next) => {
  req.logout((err) => {
    if (err) return next(err);
    req.session.destroy(() => {
      res.clearCookie('cardioai.sid');
      res.redirect('/login');
    });
  });
});

// ---------------------------------------------------------------------------
// Auth guards
// ---------------------------------------------------------------------------
function ensureAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.redirect('/login');
}
function ensureApiAuth(req, res, next) {
  if (req.isAuthenticated && req.isAuthenticated()) return next();
  return res.status(401).json({ error: 'unauthenticated' });
}

app.get('/api/me', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) {
    return res.json({ authenticated: true, user: req.user });
  }
  return res.status(401).json({ authenticated: false });
});

app.get('/healthz', (req, res) =>
  res.json({ ok: true, env: NODE_ENV, store: store.driver })
);

// ── Integration: OUTBOUND pipeline (server-to-server, shared key) ──
// The Operations hub (or any service holding INTEGRATION_API_KEY) pulls this
// CRM's deals from here. No Google session — authenticated by x-api-key only.
app.get('/api/integrations/pipeline', async (req, res, next) => {
  if (!integrations.INTEGRATION_API_KEY) {
    return res.status(503).json({ error: 'integration_not_configured' });
  }
  const provided = req.get('x-api-key') || req.query.key;
  if (!integrations.keyOk(provided)) {
    return res.status(401).json({ error: 'invalid_api_key' });
  }
  try {
    const deals = await integrations.buildOutboundPipeline(store);
    res.json({ deals, count: deals.length, source: 'cardio-crm' });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// REST API (all protected)
// ---------------------------------------------------------------------------
const api = express.Router();
api.use(ensureApiAuth);

function isValidCollection(name) {
  return COLLECTIONS.includes(name);
}

// ── Integration: INBOUND (read-only deals pulled from upstream sources) ──
// Surfaced to the signed-in CRM UI and merged alongside manual deals.
api.get('/integrations/external', async (req, res, next) => {
  try {
    res.json(await integrations.getExternalPipeline());
  } catch (e) {
    next(e);
  }
});
api.get('/integrations/status', (req, res) => res.json(integrations.status()));

// Reshape the flat `deals` rows into the stage-keyed object the SPA expects.
function dealsToStageMap(dealRows) {
  const map = {};
  for (const d of dealRows) {
    const stage = d.stage || 'Discovery';
    if (!map[stage]) map[stage] = [];
    // strip the persisted `stage` key from the card the UI renders
    const { stage: _omit, ...card } = d;
    map[stage].push(card);
  }
  return map;
}

// Flatten a stage-keyed deals object back into rows carrying their stage.
function stageMapToDeals(stageMap) {
  const rows = [];
  for (const [stage, cards] of Object.entries(stageMap || {})) {
    for (const card of cards) rows.push({ ...card, stage });
  }
  return rows;
}

// Everything the SPA needs at boot, in one round-trip.
api.get('/bootstrap', async (req, res, next) => {
  try {
    const [contacts, deals, tasks, notifications, activities, sequences] =
      await Promise.all(COLLECTIONS.map((c) => store.list(c)));
    res.json({
      contacts,
      deals: dealsToStageMap(deals),
      tasks,
      notifications,
      activities,
      sequences,
    });
  } catch (e) {
    next(e);
  }
});

// Bulk replace of the whole working set (used by the SPA's debounced save).
api.put('/state', async (req, res, next) => {
  try {
    const body = req.body || {};
    const payload = {
      contacts: Array.isArray(body.contacts) ? body.contacts : null,
      deals: body.deals ? stageMapToDeals(body.deals) : null,
      tasks: Array.isArray(body.tasks) ? body.tasks : null,
      notifications: Array.isArray(body.notifications)
        ? body.notifications
        : null,
      activities: Array.isArray(body.activities) ? body.activities : null,
      sequences: Array.isArray(body.sequences) ? body.sequences : null,
    };
    for (const col of COLLECTIONS) {
      if (payload[col] !== null) {
        await store.replaceCollection(col, payload[col]);
      }
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Computed dashboard metrics (kept server-side so reports stay consistent).
api.get('/dashboard', async (req, res, next) => {
  try {
    const [contacts, deals, tasks, notifications] = await Promise.all([
      store.list('contacts'),
      store.list('deals'),
      store.list('tasks'),
      store.list('notifications'),
    ]);
    const pipelineValue = deals.reduce((a, d) => a + (Number(d.value) || 0), 0);
    const byStage = {};
    for (const d of deals) {
      const s = d.stage || 'Discovery';
      byStage[s] = byStage[s] || { count: 0, value: 0 };
      byStage[s].count += 1;
      byStage[s].value += Number(d.value) || 0;
    }
    res.json({
      contacts: contacts.length,
      deals: deals.length,
      pipelineValue,
      weightedForecast: Math.round(pipelineValue * 0.57),
      openTasks: tasks.filter((t) => !t.done).length,
      unreadAlerts: notifications.filter((n) => n.unread).length,
      byStage,
    });
  } catch (e) {
    next(e);
  }
});

// Generic collection CRUD ---------------------------------------------------
api.get('/:collection', async (req, res, next) => {
  const { collection } = req.params;
  if (!isValidCollection(collection))
    return res.status(404).json({ error: 'unknown_collection' });
  try {
    const items = await store.list(collection);
    res.json(collection === 'deals' ? dealsToStageMap(items) : items);
  } catch (e) {
    next(e);
  }
});

api.post('/:collection', async (req, res, next) => {
  const { collection } = req.params;
  if (!isValidCollection(collection))
    return res.status(404).json({ error: 'unknown_collection' });
  try {
    const item = req.body || {};
    if (!item.id) item.id = `${collection.slice(0, 1)}-${Date.now().toString(36)}`;
    await store.put(collection, item.id, item);
    res.status(201).json(item);
  } catch (e) {
    next(e);
  }
});

api.put('/:collection/:id', async (req, res, next) => {
  const { collection, id } = req.params;
  if (!isValidCollection(collection))
    return res.status(404).json({ error: 'unknown_collection' });
  try {
    const existing = (await store.get(collection, id)) || { id };
    const merged = { ...existing, ...(req.body || {}), id };
    await store.put(collection, id, merged);
    res.json(merged);
  } catch (e) {
    next(e);
  }
});

api.delete('/:collection/:id', async (req, res, next) => {
  const { collection, id } = req.params;
  if (!isValidCollection(collection))
    return res.status(404).json({ error: 'unknown_collection' });
  try {
    await store.remove(collection, id);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.use('/api', api);

// ---------------------------------------------------------------------------
// AI Assistant proxy (protected) — keeps the Anthropic key server-side
// ---------------------------------------------------------------------------
app.post('/api/ai/chat', ensureApiAuth, async (req, res) => {
  const { message, system } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'message_required' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ai_not_configured' });
  }
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: ANTHROPIC_MODEL,
        max_tokens: 700,
        system: typeof system === 'string' ? system : undefined,
        messages: [{ role: 'user', content: message }],
      }),
    });
    if (!r.ok) {
      const detail = await r.text();
      console.error('[ai] Anthropic error', r.status, detail.slice(0, 300));
      return res.status(502).json({ error: 'ai_upstream_error', status: r.status });
    }
    const data = await r.json();
    const reply =
      (data.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n') || 'No response.';
    res.json({ reply });
  } catch (e) {
    console.error('[ai] proxy failure:', e.message);
    res.status(502).json({ error: 'ai_upstream_error' });
  }
});

// ---------------------------------------------------------------------------
// Page routes + static assets
// ---------------------------------------------------------------------------
function asset(name) {
  const inPublic = path.join(__dirname, 'public', name);
  if (fs.existsSync(inPublic)) return inPublic;
  const inRoot = path.join(__dirname, name);
  if (fs.existsSync(inRoot)) return inRoot;
  return null;
}

app.get('/login', (req, res) => {
  if (req.isAuthenticated && req.isAuthenticated()) return res.redirect('/');
  const loginFile = asset('login.html');
  if (loginFile) return res.sendFile(loginFile);
  res.type('html').send(
    `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign in · Cardio AI CRM</title>
    <style>body{font-family:system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;
    justify-content:center;margin:0;background:linear-gradient(135deg,#08131f,#162840);color:#e8f0f8}
    .card{background:#0f1e30;border:1px solid rgba(100,160,220,.18);border-radius:16px;padding:2.5rem;text-align:center;max-width:380px}
    h1{font-size:1.4rem;margin:0 0 .5rem}p{color:#8fa8c0;margin:0 0 1.5rem}
    a{display:inline-block;background:#fff;color:#1f2937;text-decoration:none;font-weight:600;
    padding:.85rem 1.5rem;border-radius:10px}</style></head>
    <body><div class="card"><div style="font-size:2.5rem">🫀</div>
    <h1>Cardio AI CRM Pro</h1><p>Sign in with your company Google account.</p>
    <a href="/auth/google">Sign in with Google</a></div></body></html>`
  );
});

// Serve static files from /public (but never auto-serve index.html unguarded).
app.use(
  express.static(path.join(__dirname, 'public'), { index: false })
);

app.get('/', ensureAuth, (req, res) => {
  const file = asset('index.html');
  if (file) return res.sendFile(file);
  console.error('[serve] MISSING index.html (looked in ./public and ./)');
  res
    .status(500)
    .type('html')
    .send(
      '<div style="font-family:system-ui;max-width:640px;margin:4rem auto;line-height:1.6">' +
        '<h2>Dashboard file not found</h2>' +
        "<p>You're signed in, but the server can't find <code>index.html</code> in " +
        '<code>public/</code> or the repo root.</p></div>'
    );
});

// ---------------------------------------------------------------------------
// Error handler
// ---------------------------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[error]', err.message);
  if (res.headersSent) return;
  res.status(500).json({ error: 'server_error' });
});

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(async () => {
  try {
    await store.init();
    console.log(`[storage] driver = ${store.driver}`);
    app.listen(PORT, () => {
      console.log(`Cardio AI CRM Pro listening on ${PORT} (${NODE_ENV})`);
      console.log(`Base URL: ${BASE_URL}`);
      console.log(`Allowed domains: ${ALLOWED_DOMAINS.join(', ') || '(none)'}`);
    });
  } catch (e) {
    console.error('[boot] failed to start:', e.message);
    process.exit(1);
  }
})();
