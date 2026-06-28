'use strict';

/*
 * storage.js — persistence layer for Cardio AI CRM Pro.
 *
 * Two interchangeable drivers behind one async interface (mirrors the
 * Cardio AI Operations platform so both apps share the same shape):
 *
 *   - postgres : used when DATABASE_URL is set (production / Render).
 *                Generic document store — tables `documents`, `singletons`,
 *                and `session` (the last is managed by connect-pg-simple).
 *   - file     : zero-setup local-dev fallback writing to ./data.json.
 *
 * Data model: every CRM record lives in a `collection` (contacts, deals,
 * tasks, notifications, activities, sequences) as a JSON document keyed by
 * its own `id`. This keeps the API generic while still being real,
 * queryable Postgres rows (data is JSONB, not an opaque blob).
 */

const fs = require('fs');
const path = require('path');

const SEED_FILE = path.join(__dirname, 'seed.json');
const DATA_FILE = path.join(__dirname, 'data.json');

const COLLECTIONS = [
  'contacts',
  'deals',
  'tasks',
  'notifications',
  'activities',
  'sequences',
];

function loadSeed() {
  try {
    return JSON.parse(fs.readFileSync(SEED_FILE, 'utf8'));
  } catch (e) {
    console.warn('[storage] Could not read seed.json:', e.message);
    return { collections: {}, singletons: {} };
  }
}

// ---------------------------------------------------------------------------
// Postgres driver
// ---------------------------------------------------------------------------
function createPostgresStore() {
  const { Pool } = require('pg');
  const connectionString = process.env.DATABASE_URL;
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString || '');
  const pool = new Pool({
    connectionString,
    ssl: isLocal || process.env.PGSSL_DISABLE === 'true'
      ? false
      : { rejectUnauthorized: false },
    max: Number(process.env.PG_POOL_MAX || 10),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
  pool.on('error', (err) =>
    console.error('[storage] idle pg client error:', err.message)
  );

  async function init() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS documents (
        collection  TEXT        NOT NULL,
        id          TEXT        NOT NULL,
        data        JSONB       NOT NULL,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (collection, id)
      );
    `);
    await pool.query(
      `CREATE INDEX IF NOT EXISTS documents_collection_idx ON documents (collection);`
    );
    await pool.query(`
      CREATE TABLE IF NOT EXISTS singletons (
        key   TEXT  PRIMARY KEY,
        data  JSONB NOT NULL
      );
    `);

    // Seed only when the store is completely empty (first boot).
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM documents;');
    if (rows[0].n === 0) {
      const seed = loadSeed();
      await seedInto(seed);
      console.log('[storage] Seeded empty Postgres store from seed.json');
    }
  }

  async function seedInto(seed) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const col of COLLECTIONS) {
        const items = (seed.collections && seed.collections[col]) || [];
        for (const item of items) {
          await client.query(
            `INSERT INTO documents (collection, id, data)
             VALUES ($1, $2, $3)
             ON CONFLICT (collection, id)
             DO UPDATE SET data = EXCLUDED.data, updated_at = now();`,
            [col, String(item.id), item]
          );
        }
      }
      for (const [key, data] of Object.entries(seed.singletons || {})) {
        await client.query(
          `INSERT INTO singletons (key, data) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data;`,
          [key, data]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function list(collection) {
    const { rows } = await pool.query(
      'SELECT data FROM documents WHERE collection = $1 ORDER BY created_at ASC;',
      [collection]
    );
    return rows.map((r) => r.data);
  }

  async function get(collection, id) {
    const { rows } = await pool.query(
      'SELECT data FROM documents WHERE collection = $1 AND id = $2;',
      [collection, String(id)]
    );
    return rows[0] ? rows[0].data : null;
  }

  async function put(collection, id, data) {
    await pool.query(
      `INSERT INTO documents (collection, id, data)
       VALUES ($1, $2, $3)
       ON CONFLICT (collection, id)
       DO UPDATE SET data = EXCLUDED.data, updated_at = now();`,
      [collection, String(id), data]
    );
    return data;
  }

  async function remove(collection, id) {
    await pool.query(
      'DELETE FROM documents WHERE collection = $1 AND id = $2;',
      [collection, String(id)]
    );
  }

  // Replace the entire contents of one collection in a single transaction.
  async function replaceCollection(collection, items) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM documents WHERE collection = $1;', [
        collection,
      ]);
      for (const item of items) {
        await client.query(
          `INSERT INTO documents (collection, id, data) VALUES ($1, $2, $3);`,
          [collection, String(item.id), item]
        );
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async function getSingleton(key) {
    const { rows } = await pool.query(
      'SELECT data FROM singletons WHERE key = $1;',
      [key]
    );
    return rows[0] ? rows[0].data : null;
  }

  async function putSingleton(key, data) {
    await pool.query(
      `INSERT INTO singletons (key, data) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET data = EXCLUDED.data;`,
      [key, data]
    );
    return data;
  }

  return {
    driver: 'postgres',
    _pool: pool,
    collections: COLLECTIONS,
    init,
    list,
    get,
    put,
    remove,
    replaceCollection,
    getSingleton,
    putSingleton,
  };
}

// ---------------------------------------------------------------------------
// File driver (local dev only)
// ---------------------------------------------------------------------------
function createFileStore() {
  let db = { collections: {}, singletons: {} };

  function persist() {
    fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2));
  }

  async function init() {
    if (fs.existsSync(DATA_FILE)) {
      db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } else {
      const seed = loadSeed();
      db = {
        collections: {},
        singletons: seed.singletons || {},
      };
      for (const col of COLLECTIONS) {
        db.collections[col] = (seed.collections && seed.collections[col]) || [];
      }
      persist();
      console.log('[storage] Seeded local data.json from seed.json');
    }
    // Ensure every known collection exists.
    for (const col of COLLECTIONS) {
      if (!db.collections[col]) db.collections[col] = [];
    }
  }

  async function list(collection) {
    return (db.collections[collection] || []).slice();
  }
  async function get(collection, id) {
    return (db.collections[collection] || []).find(
      (x) => String(x.id) === String(id)
    ) || null;
  }
  async function put(collection, id, data) {
    if (!db.collections[collection]) db.collections[collection] = [];
    const arr = db.collections[collection];
    const i = arr.findIndex((x) => String(x.id) === String(id));
    if (i > -1) arr[i] = data;
    else arr.push(data);
    persist();
    return data;
  }
  async function remove(collection, id) {
    if (!db.collections[collection]) return;
    db.collections[collection] = db.collections[collection].filter(
      (x) => String(x.id) !== String(id)
    );
    persist();
  }
  async function replaceCollection(collection, items) {
    db.collections[collection] = items.slice();
    persist();
  }
  async function getSingleton(key) {
    return db.singletons[key] || null;
  }
  async function putSingleton(key, data) {
    db.singletons[key] = data;
    persist();
    return data;
  }

  return {
    driver: 'file',
    _pool: null,
    collections: COLLECTIONS,
    init,
    list,
    get,
    put,
    remove,
    replaceCollection,
    getSingleton,
    putSingleton,
  };
}

function createStore() {
  return process.env.DATABASE_URL ? createPostgresStore() : createFileStore();
}

module.exports = { createStore, COLLECTIONS };
