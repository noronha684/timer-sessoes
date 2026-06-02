// Timer de Sessões — Cloudflare Worker
// Binding necessário: DB → D1 'timer-sessoes'
// Deploy: cole esse arquivo em Workers no painel da Cloudflare,
// vá em Settings → Bindings → Add binding → D1 database → Variable name "DB" → escolha "timer-sessoes" → Save.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders,
    },
  });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === '/api/snapshot' && request.method === 'GET') return apiSnapshot(request, env);
      if (path === '/api/session' && request.method === 'POST') return apiAddSession(request, env);
      if (path === '/api/categories' && request.method === 'PUT') return apiPutCategories(request, env);
      if (path === '/api/settings' && request.method === 'PUT') return apiPutSetting(request, env);
      if (path === '/api/sync' && request.method === 'POST') return apiBulkSync(request, env);
      if (path === '/api/ping' && request.method === 'GET') return json({ ok: true, now: Date.now() });
      return json({ error: 'not found', path }, 404);
    } catch (e) {
      return json({ error: e.message, stack: e.stack }, 500);
    }
  },
};

// ====== Helpers ======
function buildSnapshot(rows) {
  const sessions = {};
  const history = {};
  for (const s of rows) {
    if (!sessions[s.date]) sessions[s.date] = [];
    if (!history[s.date]) history[s.date] = {};
    sessions[s.date].push({ category: s.category, durationMs: s.duration_ms, at: s.started_at });
    history[s.date][s.category] = (history[s.date][s.category] || 0) + s.duration_ms;
  }
  return { sessions, history };
}

async function loadFullSnapshot(env, uid) {
  const [sessions, categories, settings] = await Promise.all([
    env.DB.prepare('SELECT date, category, duration_ms, started_at FROM sessions WHERE uid = ? ORDER BY started_at ASC').bind(uid).all(),
    env.DB.prepare('SELECT name FROM categories WHERE uid = ? ORDER BY position ASC, name ASC').bind(uid).all(),
    env.DB.prepare('SELECT key, value FROM settings WHERE uid = ?').bind(uid).all(),
  ]);
  const { sessions: sessionsObj, history } = buildSnapshot(sessions.results || []);
  const settingsObj = {};
  for (const s of (settings.results || [])) {
    try { settingsObj[s.key] = JSON.parse(s.value); } catch { settingsObj[s.key] = s.value; }
  }
  return {
    sessions: sessionsObj,
    history,
    categories: (categories.results || []).map(c => c.name),
    settings: settingsObj,
    serverTime: Date.now(),
  };
}

// ====== Endpoints ======
async function apiSnapshot(request, env) {
  const uid = new URL(request.url).searchParams.get('uid');
  if (!uid) return json({ error: 'uid required' }, 400);
  const snap = await loadFullSnapshot(env, uid);
  return json(snap);
}

async function apiAddSession(request, env) {
  const body = await request.json();
  const { uid, date, category, durationMs, startedAt } = body || {};
  if (!uid || !date || !category || !durationMs) {
    return json({ error: 'missing fields', need: ['uid', 'date', 'category', 'durationMs'] }, 400);
  }
  await env.DB.prepare(
    'INSERT OR IGNORE INTO sessions (uid, date, category, duration_ms, started_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(uid, date, category, durationMs, startedAt || Date.now()).run();
  return json({ ok: true });
}

async function apiPutCategories(request, env) {
  const body = await request.json();
  const { uid, categories } = body || {};
  if (!uid || !Array.isArray(categories)) return json({ error: 'invalid body' }, 400);
  const stmts = [env.DB.prepare('DELETE FROM categories WHERE uid = ?').bind(uid)];
  categories.forEach((name, idx) => {
    if (typeof name === 'string' && name.trim()) {
      stmts.push(env.DB.prepare('INSERT INTO categories (uid, name, position) VALUES (?, ?, ?)').bind(uid, name.trim(), idx));
    }
  });
  await env.DB.batch(stmts);
  return json({ ok: true });
}

async function apiPutSetting(request, env) {
  const body = await request.json();
  const { uid, key, value } = body || {};
  if (!uid || !key) return json({ error: 'invalid body' }, 400);
  await env.DB.prepare(
    'INSERT INTO settings (uid, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(uid, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind(uid, key, JSON.stringify(value), Date.now()).run();
  return json({ ok: true });
}

async function apiBulkSync(request, env) {
  const body = await request.json();
  const { uid, sessions, categories, settings } = body || {};
  if (!uid) return json({ error: 'uid required' }, 400);

  const stmts = [];

  // Sessions: INSERT OR IGNORE (dedupe via UNIQUE index uid+started_at+category)
  if (sessions && typeof sessions === 'object') {
    for (const date in sessions) {
      const list = sessions[date];
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        if (s && s.at && s.category && s.durationMs) {
          stmts.push(env.DB.prepare(
            'INSERT OR IGNORE INTO sessions (uid, date, category, duration_ms, started_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(uid, date, s.category, s.durationMs, s.at));
        }
      }
    }
  }

  // Categories: replace (union já é feito no client antes de mandar)
  if (Array.isArray(categories) && categories.length > 0) {
    stmts.push(env.DB.prepare('DELETE FROM categories WHERE uid = ?').bind(uid));
    categories.forEach((name, idx) => {
      if (typeof name === 'string' && name.trim()) {
        stmts.push(env.DB.prepare('INSERT INTO categories (uid, name, position) VALUES (?, ?, ?)').bind(uid, name.trim(), idx));
      }
    });
  }

  // Settings: upsert
  if (settings && typeof settings === 'object') {
    for (const key in settings) {
      stmts.push(env.DB.prepare(
        'INSERT INTO settings (uid, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(uid, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
      ).bind(uid, key, JSON.stringify(settings[key]), Date.now()));
    }
  }

  if (stmts.length > 0) await env.DB.batch(stmts);

  const snap = await loadFullSnapshot(env, uid);
  return json(snap);
}
