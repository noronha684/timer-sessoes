// Timer de Sessões — Cloudflare Worker (API)
// Binding: DB → D1 'timer-sessoes' (já declarado em wrangler.api.jsonc)
// Deploy direto (sem GitHub):  wrangler deploy -c wrangler.api.jsonc
// Secret do Whoop:             wrangler secret put WHOOP_CLIENT_SECRET -c wrangler.api.jsonc

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
      // ===== Whoop OAuth =====
      if (path === '/oauth/whoop/login' && request.method === 'GET') return whoopLogin(request, env);
      if (path === '/oauth/whoop/callback' && request.method === 'GET') return whoopCallback(request, env);
      if (path === '/api/whoop/status' && request.method === 'GET') return whoopStatus(request, env);
      if (path === '/api/whoop/sync' && request.method === 'POST') return whoopSync(request, env);
      if (path === '/api/whoop/disconnect' && request.method === 'POST') return whoopDisconnect(request, env);
      return json({ error: 'not found', path }, 404);
    } catch (e) {
      return json({ error: e.message, stack: e.stack }, 500);
    }
  },
};

// ====== Whoop OAuth ======
const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API = 'https://api.prod.whoop.com/developer';
const WHOOP_SCOPES = 'read:sleep read:recovery read:profile offline';

function randomState() {
  const arr = new Uint8Array(16);
  crypto.getRandomValues(arr);
  return [...arr].map(b => b.toString(16).padStart(2, '0')).join('');
}

// Inicia o fluxo OAuth: ?uid=... → redireciona pro Whoop
async function whoopLogin(request, env) {
  const uid = new URL(request.url).searchParams.get('uid');
  if (!uid) return json({ error: 'uid required' }, 400);
  if (!env.WHOOP_CLIENT_ID) return json({ error: 'WHOOP_CLIENT_ID not configured' }, 500);

  const state = randomState();
  await env.DB.prepare('INSERT OR REPLACE INTO oauth_states (state, uid) VALUES (?, ?)').bind(state, uid).run();

  const redirectUri = `${new URL(request.url).origin}/oauth/whoop/callback`;
  const authUrl = new URL(WHOOP_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', env.WHOOP_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', WHOOP_SCOPES);
  authUrl.searchParams.set('state', state);
  return Response.redirect(authUrl.toString(), 302);
}

// Whoop redireciona de volta com ?code=...&state=...
async function whoopCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return htmlResult('Erro', 'Faltou code ou state na resposta do Whoop.');

  const stateRow = await env.DB.prepare('SELECT uid FROM oauth_states WHERE state = ?').bind(state).first();
  if (!stateRow) return htmlResult('Erro', 'State inválido ou expirado. Tente conectar novamente.');
  const uid = stateRow.uid;
  await env.DB.prepare('DELETE FROM oauth_states WHERE state = ?').bind(state).run();

  const redirectUri = `${url.origin}/oauth/whoop/callback`;
  const tokenRes = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: env.WHOOP_CLIENT_ID,
      client_secret: env.WHOOP_CLIENT_SECRET,
    }),
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    return htmlResult('Erro', 'Falha ao trocar token: ' + txt);
  }
  const tok = await tokenRes.json();
  const expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
  await env.DB.prepare(
    'INSERT OR REPLACE INTO whoop_tokens (uid, access_token, refresh_token, expires_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(uid, tok.access_token, tok.refresh_token || null, expiresAt, Date.now()).run();

  return htmlResult('Whoop conectado!', 'Você pode fechar esta aba e voltar ao app. Seus dados de sono serão sincronizados.', true);
}

function htmlResult(title, msg, success = false) {
  return new Response(
    `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>body{font-family:-apple-system,sans-serif;background:#0f0f17;color:#ededf0;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:20px;text-align:center}
    .box{max-width:340px}.icon{font-size:48px;margin-bottom:16px}h1{font-size:20px;margin:0 0 12px}p{color:#9d9db0;line-height:1.5;font-size:14px}</style></head>
    <body><div class="box"><div class="icon">${success ? '✓' : '⚠️'}</div><h1>${title}</h1><p>${msg}</p></div>
    <script>${success ? 'setTimeout(()=>{try{window.close()}catch(e){}},3000);' : ''}</script></body></html>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', ...corsHeaders } }
  );
}

// Garante um access token válido (refresh se expirado)
async function getValidWhoopToken(env, uid) {
  const row = await env.DB.prepare('SELECT * FROM whoop_tokens WHERE uid = ?').bind(uid).first();
  if (!row) return null;
  if (Date.now() < row.expires_at - 60000) return row.access_token;
  // Expirou → refresh
  if (!row.refresh_token) return null;
  const res = await fetch(WHOOP_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: row.refresh_token,
      client_id: env.WHOOP_CLIENT_ID,
      client_secret: env.WHOOP_CLIENT_SECRET,
      scope: 'offline',
    }),
  });
  if (!res.ok) return null;
  const tok = await res.json();
  const expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
  await env.DB.prepare(
    'UPDATE whoop_tokens SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE uid = ?'
  ).bind(tok.access_token, tok.refresh_token || row.refresh_token, expiresAt, Date.now(), uid).run();
  return tok.access_token;
}

async function whoopStatus(request, env) {
  const uid = new URL(request.url).searchParams.get('uid');
  if (!uid) return json({ error: 'uid required' }, 400);
  const row = await env.DB.prepare('SELECT uid, expires_at FROM whoop_tokens WHERE uid = ?').bind(uid).first();
  return json({ connected: !!row });
}

async function whoopDisconnect(request, env) {
  const body = await request.json();
  const uid = body && body.uid;
  if (!uid) return json({ error: 'uid required' }, 400);
  await env.DB.prepare('DELETE FROM whoop_tokens WHERE uid = ?').bind(uid).run();
  return json({ ok: true });
}

// Busca sleep records do Whoop e grava como settings/sleep no D1
async function whoopSync(request, env) {
  const body = await request.json();
  const uid = body && body.uid;
  if (!uid) return json({ error: 'uid required' }, 400);
  const token = await getValidWhoopToken(env, uid);
  if (!token) return json({ error: 'not_connected' }, 401);

  // Tenta v2 (atual); se falhar, cai pra v1 (legado)
  let res = await fetch(`${WHOOP_API}/v2/activity/sleep?limit=25`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let apiVersion = 'v2';
  if (res.status === 404) {
    res = await fetch(`${WHOOP_API}/v1/activity/sleep?limit=25`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    apiVersion = 'v1';
  }
  if (!res.ok) {
    const txt = await res.text();
    return json({ error: 'whoop_api_failed', status: res.status, version: apiVersion, detail: txt }, 502);
  }
  const data = await res.json();
  const records = data.records || [];
  const sleepByDate = {};
  for (const r of records) {
    if (r.nap) continue; // ignora cochilos
    const start = r.start ? new Date(r.start) : null;
    const end = r.end ? new Date(r.end) : null;
    if (!start || !end) continue;
    // Atribui ao dia do despertar (end), em data local-ish (usa a data do end UTC)
    const dateKey = end.toISOString().slice(0, 10);
    // Duração de sono = total in bed - awake time (se disponível)
    let durationMin = Math.round((end - start) / 60000);
    const stage = r.score && r.score.stage_summary;
    if (stage && typeof stage.total_awake_time_milli === 'number') {
      durationMin -= Math.round(stage.total_awake_time_milli / 60000);
    }
    if (durationMin > 0) sleepByDate[dateKey] = {
      durationMin,
      source: 'whoop',
      at: Date.now(),
      start: start.getTime(),
      end: end.getTime(),
    };
  }

  // Salva em settings.sleep (merge com o existente)
  const existingRow = await env.DB.prepare("SELECT value FROM settings WHERE uid = ? AND key = 'sleep'").bind(uid).first();
  let sleep = {};
  if (existingRow && existingRow.value) {
    try { sleep = JSON.parse(existingRow.value); } catch {}
  }
  // Whoop sobrescreve manual (mais confiável)
  Object.assign(sleep, sleepByDate);
  await env.DB.prepare(
    "INSERT INTO settings (uid, key, value, updated_at) VALUES (?, 'sleep', ?, ?) ON CONFLICT(uid, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).bind(uid, JSON.stringify(sleep), Date.now()).run();

  return json({ ok: true, synced: Object.keys(sleepByDate).length, sleep });
}

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
