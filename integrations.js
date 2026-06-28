'use strict';

/*
 * integrations.js — connects this CRM to the Cardio AI ecosystem.
 *
 * The ecosystem uses one shared contract for pipeline exchange:
 *
 *     GET /api/integrations/pipeline
 *     Header:  x-api-key: <INTEGRATION_API_KEY>
 *     200  ->  { "deals": [ ... ], "count": N }   (a bare array also works)
 *     401  ->  wrong / missing key
 *
 * This module does BOTH sides of that contract:
 *   - OUTBOUND: build this CRM's deals in the shared shape so the Operations
 *     hub (or anything with the key) can pull them.
 *   - INBOUND : pull pipeline from configured upstreams (the Sales Engine and/or
 *     the Operations platform), map into this CRM's deal shape, cache, and serve
 *     them as read-only "connected" deals merged alongside manual entries.
 *
 * Same shared secret (INTEGRATION_API_KEY) on every service. No browser exposure.
 */

const INTEGRATION_API_KEY = process.env.INTEGRATION_API_KEY || '';
const CACHE_MS = Number(process.env.INTEGRATION_CACHE_MS || 60000); // 60s default
// When true, the OUTBOUND pipeline also includes deals this CRM pulled from
// upstreams (so the CRM can act as a single aggregated source for the ops hub).
// Default false keeps outbound = this CRM's own deals (prevents double-counting
// if the hub also pulls those upstreams directly).
const EXPORT_EXTERNAL = process.env.INTEGRATION_EXPORT_EXTERNAL === 'true';

// Upstream sources to pull FROM (inbound). Both optional.
const UPSTREAMS = [
  { name: 'sales-engine', url: (process.env.SALES_ENGINE_URL || '').replace(/\/+$/, '') },
  { name: 'operations', url: (process.env.OPERATIONS_URL || '').replace(/\/+$/, '') },
].filter((s) => s.url);

// CRM pipeline stages (the kanban columns the UI renders).
const CRM_STAGES = ['Discovery', 'Demo / Eval', 'Proposal Sent', 'Negotiation', 'Closed Won'];

// Stage → typical win probability, used when a source doesn't provide one.
const STAGE_PROBABILITY = {
  Discovery: 20,
  'Demo / Eval': 40,
  'Proposal Sent': 55,
  Negotiation: 75,
  'Closed Won': 100,
};

// First-match-wins field picker (tolerant of differing source schemas).
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

// Parse "$540K", "1.2M", "880000", 250000 → a number.
function parseValue(raw) {
  if (typeof raw === 'number') return raw;
  if (!raw) return 0;
  const s = String(raw).trim().replace(/[$,\s]/g, '');
  const m = s.match(/^(-?[\d.]+)([kKmMbB]?)$/);
  if (!m) return Number(s) || 0;
  const n = parseFloat(m[1]);
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[m[2].toLowerCase()] || 1;
  return Math.round(n * mult);
}

// Map any source's stage/status text onto a CRM kanban column.
function normalizeStage(raw) {
  const s = String(raw || '').toLowerCase();
  if (/closed.*won|won|signed|closed/.test(s)) return 'Closed Won';
  if (/negotiat|closing|contract|loi/.test(s)) return 'Negotiation';
  if (/proposal|quote|pricing/.test(s)) return 'Proposal Sent';
  if (/demo|eval|qualif|assessment|poc|pilot/.test(s)) return 'Demo / Eval';
  if (/prospect|discovery|lead|new|intro/.test(s)) return 'Discovery';
  return CRM_STAGES.includes(raw) ? raw : 'Discovery';
}

// ---------------------------------------------------------------------------
// OUTBOUND — this CRM's deals in the shared shape (for the ops hub to pull)
// ---------------------------------------------------------------------------
async function buildOutboundPipeline(store) {
  const rows = await store.list('deals'); // each row already carries `stage`
  const own = rows.map((d) => {
    const stage = d.stage || 'Discovery';
    return {
      id: d.id,
      name: d.name,
      account: d.account || d.name,
      contact: d.contact && d.contact !== '—' ? d.contact : undefined,
      stage,
      value: Number(d.value) || 0,
      probability: d.probability != null ? d.probability : STAGE_PROBABILITY[stage] || 0,
      owner: d.owner || d.tier,
      tier: d.tier,
      nextAction: d.nextAction,
      source: 'cardio-crm',
      updatedAt: new Date().toISOString(),
    };
  });
  if (!EXPORT_EXTERNAL) return own;
  // Aggregate mode: also relay the deals this CRM pulled from upstreams.
  const ext = await getExternalPipeline();
  const relayed = ext.deals.map((d) => ({
    id: d.id,
    name: d.name,
    account: d.account,
    contact: d.contact && d.contact !== '—' ? d.contact : undefined,
    stage: d.stage,
    value: d.value,
    probability: d.probability,
    owner: d.tier,
    source: d.source,
    updatedAt: new Date().toISOString(),
  }));
  return own.concat(relayed);
}

// ---------------------------------------------------------------------------
// INBOUND — pull upstream pipelines, map to CRM cards, cache
// ---------------------------------------------------------------------------
let _cache = { ts: 0, payload: null };

function mapInboundDeal(record, sourceName) {
  const account = pick(record, ['account', 'company', 'organization', 'name']) || 'Unknown';
  const value = parseValue(pick(record, ['value', 'amount', 'dealValue', 'dealSize']));
  const stage = normalizeStage(pick(record, ['stage', 'status']));
  const owner = pick(record, ['owner', 'rep', 'assignedTo', 'salesRep']);
  const contact = pick(record, ['contact', 'contactName', 'champion', 'poc']);
  const probability = pick(record, ['probability', 'winProbability']);
  const rawId = pick(record, ['id', 'dealId', '_id']) || account;
  return {
    id: `ext-${sourceName}-${rawId}`,
    name: pick(record, ['name', 'dealName']) || account,
    account,
    value,
    contact: contact || '—',
    days: 0,
    tier: owner ? String(owner) : sourceName,
    stage,
    probability: probability != null ? Number(probability) : STAGE_PROBABILITY[stage],
    source: sourceName,
    readOnly: true,
  };
}

async function fetchUpstream(src) {
  const url = `${src.url}/api/integrations/pipeline`;
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000);
  try {
    const r = await fetch(url, {
      headers: { 'x-api-key': INTEGRATION_API_KEY, accept: 'application/json' },
      signal: controller.signal,
    });
    if (!r.ok) return { name: src.name, url: src.url, ok: false, status: r.status, deals: [] };
    const data = await r.json();
    const list = Array.isArray(data) ? data : Array.isArray(data.deals) ? data.deals : [];
    return { name: src.name, url: src.url, ok: true, deals: list.map((d) => mapInboundDeal(d, src.name)) };
  } catch (e) {
    return { name: src.name, url: src.url, ok: false, error: e.message, deals: [] };
  } finally {
    clearTimeout(t);
  }
}

// Returns { byStage, deals, count, value, sources, configured } — cached CACHE_MS.
async function getExternalPipeline() {
  const now = Date.now();
  if (_cache.payload && now - _cache.ts < CACHE_MS) return _cache.payload;

  const configured = UPSTREAMS.length > 0 && !!INTEGRATION_API_KEY;
  if (!configured) {
    const empty = { byStage: {}, deals: [], count: 0, value: 0, sources: [], configured: false };
    _cache = { ts: now, payload: empty };
    return empty;
  }

  const results = await Promise.all(UPSTREAMS.map(fetchUpstream));
  const deals = results.flatMap((r) => r.deals);
  const byStage = {};
  for (const d of deals) (byStage[d.stage] = byStage[d.stage] || []).push(d);
  const payload = {
    byStage,
    deals,
    count: deals.length,
    value: deals.reduce((a, d) => a + (d.value || 0), 0),
    sources: results.map((r) => ({ name: r.name, url: r.url, ok: r.ok, count: r.deals.length, status: r.status, error: r.error })),
    configured: true,
  };
  // On total failure keep the previous good cache if we have one.
  if (payload.count === 0 && _cache.payload && _cache.payload.count > 0 && payload.sources.every((s) => !s.ok)) {
    return _cache.payload;
  }
  _cache = { ts: now, payload };
  return payload;
}

function status() {
  return {
    outboundEnabled: !!INTEGRATION_API_KEY,
    aggregateExport: EXPORT_EXTERNAL,
    inboundConfigured: UPSTREAMS.length > 0 && !!INTEGRATION_API_KEY,
    upstreams: UPSTREAMS.map((s) => ({ name: s.name, url: s.url })),
    cacheMs: CACHE_MS,
    lastFetch: _cache.ts ? new Date(_cache.ts).toISOString() : null,
  };
}

// Constant-time-ish key check.
function keyOk(provided) {
  return !!INTEGRATION_API_KEY && provided === INTEGRATION_API_KEY;
}

module.exports = {
  INTEGRATION_API_KEY,
  buildOutboundPipeline,
  getExternalPipeline,
  status,
  keyOk,
};
