// Timer de Sessões — Cloudflare Worker (API)
// Binding: DB → D1 'timer-sessoes' (já declarado em wrangler.api.jsonc)
// Deploy direto (sem GitHub):  wrangler deploy -c wrangler.api.jsonc
// Secret do Whoop:             wrangler secret put WHOOP_CLIENT_SECRET -c wrangler.api.jsonc
//
// Segurança: todo /api/* (exceto /api/ping) exige um ID token do Firebase no
// header Authorization: Bearer <token>. O uid usado é o do token VERIFICADO
// (payload.sub), nunca o que o cliente manda — assim ninguém acessa dados de outro.

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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

// ====== Verificação de ID token do Firebase (JWT RS256) ======
const FB_PROJECT_ID = 'timer-sessoes';
const FB_ISS = 'https://securetoken.google.com/' + FB_PROJECT_ID;
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

let _jwks = null;         // hot cache em memória: { keys, exp }
let _jwksLastGood = null; // último conjunto importado com sucesso (fallback stale)

function b64urlBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4;
  if (pad) s += '='.repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlJson(s) {
  return JSON.parse(new TextDecoder().decode(b64urlBytes(s)));
}

async function importJwkSet(body) {
  const keys = {};
  for (const k of (body.keys || [])) {
    if (k.kty !== 'RSA' || (k.alg && k.alg !== 'RS256') || !k.kid) continue;
    try {
      keys[k.kid] = await crypto.subtle.importKey('jwk', k, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    } catch { /* ignora chave inválida */ }
  }
  return keys;
}

// Robusto contra blip do Google: hot cache → fetch (edge-cache) → cache de colo (stale) → last-good.
// Nunca cacheia conjunto vazio; só lança se JAMAIS houve JWKS bom.
async function getJwksKeys(force) {
  const now = Date.now();
  if (!force && _jwks && _jwks.exp > now) return _jwks.keys;
  const cache = caches.default;
  const cacheKey = new Request(JWKS_URL);
  try {
    // force = rotação de chave detectada (kid novo). O refetch PRECISA furar o edge-cache do
    // Cloudflare (cache-buster na URL + cacheTtl:0) — senão devolve o MESMO JWKS stale por até
    // 1h e o token com kid novo falha com unknown_kid até o cache expirar.
    const res = force
      ? await fetch(JWKS_URL + '?_=' + now, { cf: { cacheTtl: 0 } })
      : await fetch(JWKS_URL, { cf: { cacheEverything: true, cacheTtl: 3600 } });
    if (res.ok) {
      const body = await res.json();
      const keys = await importJwkSet(body);
      if (Object.keys(keys).length > 0) {
        let ttl = 3600 * 1000;
        const cc = res.headers.get('cache-control');
        const m = cc && cc.match(/max-age=(\d+)/);
        if (m) ttl = parseInt(m[1], 10) * 1000;
        _jwks = { keys, exp: now + Math.max(60000, Math.min(ttl, 6 * 3600 * 1000)) };
        _jwksLastGood = keys;
        try {
          const copy = new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' } });
          await cache.put(cacheKey, copy);
        } catch { /* cache best-effort */ }
        return keys;
      }
    }
  } catch { /* rede falhou → fallback abaixo */ }
  // Fallback stale: cache de colo (sobrevive a cold start), depois last-good deste isolate.
  try {
    const cached = await cache.match(cacheKey);
    if (cached) {
      const keys = await importJwkSet(await cached.json());
      if (Object.keys(keys).length > 0) { _jwksLastGood = keys; return keys; }
    }
  } catch { /* ignora */ }
  if (_jwksLastGood) return _jwksLastGood;
  throw new Error('jwks_unavailable');
}

// Verifica assinatura + claims; devolve o payload (payload.sub = uid) ou lança.
async function verifyIdToken(token) {
  if (!token || typeof token !== 'string') throw new Error('no_token');
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const header = b64urlJson(parts[0]);
  if (header.alg !== 'RS256') throw new Error('bad_alg');   // rejeita 'none'/HS256 (algorithm confusion)
  if (header.typ !== 'JWT') throw new Error('bad_typ');      // exige typ=JWT (validação estrita)
  if (!header.kid) throw new Error('no_kid');

  let keys = await getJwksKeys(false);
  let key = keys[header.kid];
  if (!key) { keys = await getJwksKeys(true); key = keys[header.kid]; } // rotação de chave → refetch
  if (!key) throw new Error('unknown_kid');

  const data = new TextEncoder().encode(parts[0] + '.' + parts[1]);
  const sig = b64urlBytes(parts[2]);
  const ok = await crypto.subtle.verify({ name: 'RSASSA-PKCS1-v1_5' }, key, sig, data);
  if (!ok) throw new Error('bad_signature');

  const p = b64urlJson(parts[1]);
  const now = Math.floor(Date.now() / 1000);
  const TOL = 60; // tolerância pequena de relógio (não estende a validade materialmente)
  if (typeof p.exp !== 'number' || p.exp + TOL < now) throw new Error('expired');
  if (typeof p.iat !== 'number' || p.iat - TOL > now) throw new Error('bad_iat');
  if (typeof p.auth_time !== 'number' || p.auth_time - TOL > now) throw new Error('bad_auth_time');
  if (p.aud !== FB_PROJECT_ID) throw new Error('bad_aud');
  if (p.iss !== FB_ISS) throw new Error('bad_iss');
  if (typeof p.sub !== 'string' || !p.sub || p.sub.length > 128) throw new Error('bad_sub');
  return p;
}

// Extrai o Bearer, verifica, devolve o uid (payload.sub). Lança se inválido.
async function requireUid(request) {
  const auth = request.headers.get('Authorization') || '';
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error('no_bearer');
  return (await verifyIdToken(m[1].trim())).sub;
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      // Aberto (healthcheck)
      if (path === '/api/ping' && request.method === 'GET') return json({ ok: true, now: Date.now() });

      // Whoop OAuth callback: vem do Whoop, autenticado pelo `state` single-use que emitimos.
      if (path === '/oauth/whoop/callback' && request.method === 'GET') return whoopCallback(request, env);

      // Daqui pra baixo, tudo exige Bearer válido.
      let uid;
      try { uid = await requireUid(request); }
      catch (e) { return json({ error: 'unauthorized', detail: e.message }, 401); }

      // Diz quem é você (uid + se é o dono — o app usa pra decidir plano seed × plano
      // gerado em branco). Aberto a qualquer logado.
      if (path === '/api/whoami' && request.method === 'GET') {
        return json({ uid, owner: env.OWNER_UID ? uid === env.OWNER_UID : true });
      }

      // Allowlist: dono (OWNER_UID) + convidados (ALLOWED_UIDS, uids separados por vírgula —
      // `wrangler secret put ALLOWED_UIDS -c wrangler.api.jsonc`). Sem OWNER_UID, deixa passar.
      const allowedUids = String(env.ALLOWED_UIDS || '').split(',').map(s => s.trim()).filter(Boolean);
      if (env.OWNER_UID && uid !== env.OWNER_UID && !allowedUids.includes(uid)) return json({ error: 'forbidden' }, 403);

      if (path === '/api/snapshot' && request.method === 'GET') return apiSnapshot(request, env, uid);
      if (path === '/api/session' && request.method === 'POST') return apiAddSession(request, env, uid);
      if (path === '/api/categories' && request.method === 'PUT') return apiPutCategories(request, env, uid);
      if (path === '/api/settings' && request.method === 'PUT') return apiPutSetting(request, env, uid);
      if (path === '/api/sync' && request.method === 'POST') return apiBulkSync(request, env, uid);
      if (path === '/api/suggest-week' && request.method === 'POST') return apiSuggestWeek(request, env, uid);
      if (path === '/api/week-note' && request.method === 'POST') return apiWeekNote(request, env, uid);
      if (path === '/api/whoop/connect' && request.method === 'POST') return apiWhoopConnect(request, env, uid);
      if (path === '/api/whoop/status' && request.method === 'GET') return whoopStatus(env, uid);
      if (path === '/api/whoop/sync' && request.method === 'POST') return whoopSync(env, uid);
      if (path === '/api/whoop/disconnect' && request.method === 'POST') return whoopDisconnect(env, uid);

      return json({ error: 'not found', path }, 404);
    } catch (e) {
      console.error('worker error:', e && e.stack || e); // stack só no log, nunca no corpo
      return json({ error: 'internal' }, 500);
    }
  },
};

// ====== IA: sugere em qual semana do plano H2 encaixar uma tarefa ======
// Chama a Messages API da Anthropic direto por fetch (Worker não usa SDK).
// Secret (uma vez): wrangler secret put ANTHROPIC_API_KEY -c wrangler.api.jsonc
// Rate limit simples por uid, em memória do isolate (reseta no cold start; defesa barata
// contra loop — combinado com OWNER_UID cobre o abuso descrito na auditoria).
const _sugHits = new Map();
function suggestRateOk(uid) {
  const now = Date.now(), win = 10 * 60 * 1000, max = 25;
  const arr = (_sugHits.get(uid) || []).filter(t => now - t < win);
  if (arr.length >= max) { _sugHits.set(uid, arr); return false; }
  arr.push(now); _sugHits.set(uid, arr);
  if (_sugHits.size > 500) _sugHits.clear(); // não vazar memória se muitos uids
  return true;
}

// Teto diário PERSISTENTE por uid pros endpoints de IA (o limiter em memória é por
// isolate — Cloudflare roda N isolates, então sozinho ele não protege a conta Anthropic).
// Contador em settings ('_ai_<dia>'): 2 queries baratas por chamada, LWW irrelevante.
const AI_DAILY_CAP = 100;
async function aiDailyOk(env, uid) {
  try {
    const key = '_ai_' + new Date().toISOString().slice(0, 10);
    const row = await env.DB.prepare('SELECT value FROM settings WHERE uid = ? AND key = ?').bind(uid, key).first();
    let count = 0;
    try { count = parseInt(JSON.parse(row && row.value || '0'), 10) || 0; } catch {}
    if (count >= AI_DAILY_CAP) return false;
    await env.DB.prepare(
      'INSERT INTO settings (uid, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(uid, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
    ).bind(uid, key, JSON.stringify(count + 1), Date.now()).run();
    return true;
  } catch { return true; } // D1 fora do ar não derruba a feature (o limiter em memória segura)
}
// Corpo grande queima CPU antes dos caps de campo — barra antes do json()
function bodyTooLarge(request) {
  return +(request.headers.get('content-length') || 0) > 65536;
}

async function apiSuggestWeek(request, env, uid) {
  if (!env.ANTHROPIC_API_KEY) {
    return json({ error: 'ia_nao_configurada', detail: 'Defina o secret ANTHROPIC_API_KEY no Worker da API.' }, 501);
  }
  if (bodyTooLarge(request)) return json({ error: 'payload_too_large' }, 413);
  if (!suggestRateOk(uid)) return json({ error: 'rate_limited', detail: 'Muitas sugestões seguidas. Espere alguns minutos.' }, 429);
  if (!(await aiDailyOk(env, uid))) return json({ error: 'rate_limited', detail: 'Limite diário de IA atingido.' }, 429);
  const body = await request.json().catch(() => null);
  const task = body && typeof body.task === 'string' ? body.task.trim().slice(0, 300) : '';
  // Modo lote: tasks = [{id, text}] → responde {assignments: [{id, week, reason}]}
  const tasksArr = body && Array.isArray(body.tasks)
    ? body.tasks.slice(0, 30)
        .map(t => ({ id: String(t && t.id || '').slice(0, 40), text: String(t && t.text || '').trim().slice(0, 300) }))
        .filter(t => t.id && t.text)
    : null;
  const weeks = body && Array.isArray(body.weeks) ? body.weeks.slice(0, 30) : [];
  const today = body && typeof body.today === 'string' ? body.today.slice(0, 10) : '';
  if ((!task && !(tasksArr && tasksArr.length)) || !weeks.length) return json({ error: 'task (ou tasks) e weeks são obrigatórios' }, 400);

  // Caps em TODOS os campos (não só w.w) — evita inflar o prompt e a conta da API.
  const cap = (v, n) => String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, n);
  const plano = weeks.map(w =>
    `Semana ${cap(w.n, 6)} (${cap(w.d, 40)})${w.done ? ' [JÁ CONCLUÍDA]' : ''} — tipo: ${cap(w.t, 30)}. ${cap(w.w, 400)}`
  ).join('\n');

  const system = 'Você aloca tarefas no plano semanal do semestre de um analista de equities (setor elétrico/saneamento, Brasil). Regras: semanas de tipo Balanços são capacidade comprometida — só recebem tarefas urgentes ligadas a resultados; nunca sugira semana já concluída ou anterior a hoje; case o tema da tarefa com o foco da semana (empresa nova, análise, deep work, cadência); prazos explícitos na tarefa têm prioridade; na dúvida entre duas semanas, escolha a menos carregada.'
    + (tasksArr ? ' Ao alocar VÁRIAS tarefas, distribua a carga (evite empilhar tudo na mesma semana), aloque TODAS, uma semana por tarefa, e ecoe o id de cada uma exatamente como recebido.' : '');

  const schema = tasksArr
    ? {
        type: 'object',
        properties: {
          assignments: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'id da tarefa, ecoado exatamente' },
                week: { type: 'integer', description: 'nº da semana sugerida' },
                reason: { type: 'string', description: 'justificativa em 1 frase curta, em português' },
              },
              required: ['id', 'week', 'reason'],
              additionalProperties: false,
            },
          },
        },
        required: ['assignments'],
        additionalProperties: false,
      }
    : {
        type: 'object',
        properties: {
          week: { type: 'integer', description: 'nº da semana sugerida' },
          reason: { type: 'string', description: 'justificativa em 1 frase curta, em português' },
        },
        required: ['week', 'reason'],
        additionalProperties: false,
      };

  const userMsg = tasksArr
    ? `Hoje é ${today}.\n\nPLANO DO SEMESTRE:\n${plano}\n\nTAREFAS A ALOCAR:\n${tasksArr.map(t => `- [${t.id}] ${t.text}`).join('\n')}\n\nEm qual semana cada tarefa deve ser feita?`
    : `Hoje é ${today}.\n\nPLANO DO SEMESTRE:\n${plano}\n\nTAREFA A ALOCAR: "${task}"\n\nEm qual semana essa tarefa deve ser feita?`;

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: tasksArr ? 4096 : 1024,
      // structured output: garante que o 1º bloco de texto é JSON válido no schema
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });

  if (!resp.ok) {
    // detail fica no log do Worker — o corpo cru da Anthropic (billing, request-id)
    // não deve chegar na UI de convidado
    const detail = await resp.text().catch(() => '');
    console.error('anthropic error', resp.status, detail.slice(0, 400));
    return json({ error: 'claude_error', status: resp.status }, 502);
  }
  const data = await resp.json();
  if (data.stop_reason === 'refusal') return json({ error: 'claude_refusal' }, 502);
  const text = (data.content || []).find(b => b.type === 'text');
  let out = null;
  try { out = JSON.parse(text.text); } catch { /* cai no erro abaixo */ }
  const clampWeek = (w) => Math.min(Math.max(Math.round(w), 1), weeks.length); // range válido do plano
  if (tasksArr) {
    if (!out || !Array.isArray(out.assignments)) return json({ error: 'claude_parse' }, 502);
    const valid = new Set(tasksArr.map(t => t.id));
    const assignments = out.assignments
      .filter(a => a && valid.has(String(a.id)) && typeof a.week === 'number')
      .map(a => ({ id: String(a.id), week: clampWeek(a.week), reason: String(a.reason || '') }));
    return json({ assignments });
  }
  if (!out || typeof out.week !== 'number') return json({ error: 'claude_parse' }, 502);
  return json({ week: clampWeek(out.week), reason: String(out.reason || '') });
}

// Nota "sell-side" da semana: o Claude avalia a execução (horas vs alvo, itens, sono)
// como se fosse um resultado trimestral. Divide o rate limit do suggest-week.
async function apiWeekNote(request, env, uid) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'ia_nao_configurada' }, 501);
  if (bodyTooLarge(request)) return json({ error: 'payload_too_large' }, 413);
  if (!suggestRateOk(uid)) return json({ error: 'rate_limited', detail: 'Muitas chamadas seguidas. Espere alguns minutos.' }, 429);
  if (!(await aiDailyOk(env, uid))) return json({ error: 'rate_limited', detail: 'Limite diário de IA atingido.' }, 429);
  const body = await request.json().catch(() => null);
  if (!body || typeof body.n !== 'number') return json({ error: 'payload inválido' }, 400);
  const cap = (v, m) => String(v == null ? '' : v).replace(/\s+/g, ' ').slice(0, m);
  const fmtMap = (o) => (o && typeof o === 'object')
    ? Object.entries(o).slice(0, 12).map(([c, h]) => `${cap(c, 30)}: ${cap((+h || 0).toFixed(1), 6)}h`).join(', ') : '';
  const hours = fmtMap(body.hours);
  const targets = fmtMap(body.targets);
  const lines = Array.isArray(body.entries)
    ? body.entries.slice(0, 30).map(e => `${e && e.done ? '[FEITO]' : '[NÃO FEITO]'} ${cap(e && e.text, 140)}`).join('\n') : '';
  const sleep = (body.sleepAvgH != null && isFinite(+body.sleepAvgH)) ? (+body.sleepAvgH).toFixed(1) : '';
  const system = 'Você é um analista sell-side que cobre a EXECUÇÃO SEMANAL de um profissional de buy-side (equities, setor elétrico/saneamento, estudando pro CFA). Escreva uma nota curta de research (60–110 palavras, pt-BR) avaliando a semana dele como se fosse um resultado trimestral: comece com um rating (ex.: "Reiteramos COMPRA na execução", "Rebaixamos para NEUTRO"), compare horas entregues vs alvo por categoria, cite itens entregues e perdidos, e trate o sono como fator de risco quando relevante. Tom: research de equities — seco, quantitativo, com uma pitada de humor de mesa. Primeira pessoa do plural. Sem markdown, um parágrafo só.';
  const userMsg = `Semana ${cap(body.n, 4)} (${cap(body.dates, 40)}).\nHoras entregues por categoria: ${hours || 'n/d'}.\nHoras-alvo da semana: ${targets || 'n/d'}.\nItens/tópicos da semana:\n${lines || 'n/d'}\nSono médio no período: ${sleep ? sleep + 'h/noite' : 'n/d'}.\nStreak atual de dias com foco: ${cap(body.streak, 5)}.`;
  const schema = { type: 'object', properties: { note: { type: 'string', description: 'a nota, um parágrafo em pt-BR' } }, required: ['note'], additionalProperties: false };
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  if (!resp.ok) {
    // detail fica no log do Worker — o corpo cru da Anthropic (billing, request-id)
    // não deve chegar na UI de convidado
    const detail = await resp.text().catch(() => '');
    console.error('anthropic error', resp.status, detail.slice(0, 400));
    return json({ error: 'claude_error', status: resp.status }, 502);
  }
  const data = await resp.json();
  if (data.stop_reason === 'refusal') return json({ error: 'claude_refusal' }, 502);
  const text = (data.content || []).find(b => b.type === 'text');
  let out = null;
  try { out = JSON.parse(text.text); } catch { /* cai no erro abaixo */ }
  if (!out || typeof out.note !== 'string') return json({ error: 'claude_parse' }, 502);
  return json({ note: out.note.slice(0, 1200) });
}

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

// Inicia o fluxo OAuth do Whoop (Bearer verificado → uid). Devolve a URL de autorização;
// o ID token do Firebase NÃO trafega na URL (evita vazamento por Referer/logs/histórico).
async function apiWhoopConnect(request, env, uid) {
  if (!env.WHOOP_CLIENT_ID) return json({ error: 'WHOOP_CLIENT_ID not configured' }, 500);
  // state carimbado com o timestamp de emissão (sufixo .<ms>) — validade checada no callback,
  // sem precisar de coluna created_at nova. Evita state utilizável pra sempre.
  const state = randomState() + '.' + Date.now();
  await env.DB.prepare('INSERT OR REPLACE INTO oauth_states (state, uid) VALUES (?, ?)').bind(state, uid).run();
  const redirectUri = `${new URL(request.url).origin}/oauth/whoop/callback`;
  const authUrl = new URL(WHOOP_AUTH_URL);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('client_id', env.WHOOP_CLIENT_ID);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', WHOOP_SCOPES);
  authUrl.searchParams.set('state', state);
  return json({ url: authUrl.toString() });
}

// Whoop redireciona de volta com ?code=...&state=...
async function whoopCallback(request, env) {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  if (!code || !state) return htmlResult('Erro', 'Faltou code ou state na resposta do Whoop.');

  // Consumo atômico (DELETE ... RETURNING): dois callbacks concorrentes com o mesmo state
  // não passam os dois. Só um recebe a linha.
  const stateRow = await env.DB.prepare('DELETE FROM oauth_states WHERE state = ? RETURNING uid').bind(state).first();
  if (!stateRow) return htmlResult('Erro', 'State inválido ou já usado. Tente conectar novamente.');
  // TTL de 10 min via sufixo ".<ms>". States legados (sem sufixo numérico) não têm carimbo
  // → pulam o TTL (são single-use e raros, só na janela do deploy) em vez de falhar sempre.
  const suffix = String(state).split('.')[1];
  const issuedAt = suffix && /^\d{10,}$/.test(suffix) ? parseInt(suffix, 10) : 0;
  if (issuedAt && Date.now() - issuedAt > 10 * 60 * 1000) {
    return htmlResult('Erro', 'O link de conexão expirou. Tente conectar novamente.');
  }
  const uid = stateRow.uid;

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

async function whoopStatus(env, uid) {
  const row = await env.DB.prepare('SELECT uid, expires_at FROM whoop_tokens WHERE uid = ?').bind(uid).first();
  return json({ connected: !!row });
}

async function whoopDisconnect(env, uid) {
  await env.DB.prepare('DELETE FROM whoop_tokens WHERE uid = ?').bind(uid).run();
  return json({ ok: true });
}

// Busca sleep records do Whoop e grava como settings/sleep no D1
async function whoopSync(env, uid) {
  const token = await getValidWhoopToken(env, uid);
  if (!token) {
    // Refresh morto (token revogado): apaga a linha pra status virar not-connected
    // e o front oferecer "Conectar" de novo — senão fica preso em "Conectado" que nunca sincroniza.
    await env.DB.prepare('DELETE FROM whoop_tokens WHERE uid = ?').bind(uid).run();
    return json({ error: 'not_connected' }, 401);
  }

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
    // Chaveia pela data LOCAL (BRT, UTC-3 sem DST) do INÍCIO do sono = "a noite de X".
    // Bate com o registro manual, que assume a noite = dia anterior ao acordar (openSleepModal).
    // Antes usava end.toISOString (UTC do despertar) → divergia do manual e contava a noite 2x.
    const dateKey = new Date(start.getTime() - 3 * 3600 * 1000).toISOString().slice(0, 10);
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
  // Remove as entradas Whoop antigas antes de regravar: como a CHAVE de data mudou
  // (despertar→início do sono), reescrever sem limpar duplicaria a mesma noite em dois dias.
  // Entradas manuais (source != 'whoop') são preservadas.
  for (const k in sleep) { if (sleep[k] && sleep[k].source === 'whoop') delete sleep[k]; }
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

// Carimbo do estado do servidor: maior updated_at dos settings (relógio do SERVIDOR, seguro).
// NÃO usa started_at das sessões (vem do relógio do cliente e pode estar no futuro, o que
// travaria o ?since=). Todo push grava settings (_stamps etc.) com updated_at=now, então
// adições de sessão também bumpam este carimbo — nada de mudança fica invisível.
async function serverStamp(env, uid) {
  const s = await env.DB.prepare('SELECT MAX(updated_at) AS m FROM settings WHERE uid = ?').bind(uid).first();
  return Number((s && s.m) || 0);
}

async function loadFullSnapshot(env, uid) {
  const [sessions, categories, settings, stamp] = await Promise.all([
    env.DB.prepare('SELECT date, category, duration_ms, started_at FROM sessions WHERE uid = ? ORDER BY started_at ASC').bind(uid).all(),
    env.DB.prepare('SELECT name FROM categories WHERE uid = ? ORDER BY position ASC, name ASC').bind(uid).all(),
    env.DB.prepare('SELECT key, value, stamp, updated_at FROM settings WHERE uid = ?').bind(uid).all(),
    serverStamp(env, uid),
  ]);
  const { sessions: sessionsObj, history } = buildSnapshot(sessions.results || []);
  const settingsObj = {};
  const derivedStamps = {};
  for (const s of (settings.results || [])) {
    if (s.key === '_stamps') continue; // legado: o mapa é DERIVADO da coluna stamp abaixo
    // activeTimer fóssil (>24h sem escrita — beacon de "parei" perdido no fechamento)
    // não entra no snapshot: sem isto, devices novos adotavam uma sessão fantasma eterna
    if (s.key === 'activeTimer' && Date.now() - Number(s.updated_at || 0) > 24 * 3600 * 1000) continue;
    try { settingsObj[s.key] = JSON.parse(s.value); } catch { settingsObj[s.key] = s.value; }
    if (VERSIONED_BLOBS.has(s.key)) derivedStamps[s.key] = Number(s.stamp) || 0;
  }
  settingsObj._stamps = derivedStamps; // sempre coerente com os valores (mesma linha, mesma escrita)
  return {
    sessions: sessionsObj,
    history,
    categories: (categories.results || []).map(c => c.name),
    settings: settingsObj,
    serverStamp: stamp,
    serverTime: Date.now(),
  };
}

// ====== Endpoints (uid vem sempre do token verificado) ======
async function apiSnapshot(request, env, uid) {
  // ?since=<ms>: se nada mudou desde então, responde ~50 bytes em vez do snapshot inteiro
  const since = Number(new URL(request.url).searchParams.get('since') || 0);
  if (since > 0) {
    const stamp = await serverStamp(env, uid);
    if (stamp <= since) return json({ unchanged: true, serverStamp: stamp });
  }
  const snap = await loadFullSnapshot(env, uid);
  return json(snap);
}

// Sessão válida? date=YYYY-MM-DD, durationMs finito e >0, category string curta.
// Devolve {date, category, durationMs} saneados ou null.
function validSession(date, category, durationMs) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const d = Number(durationMs);
  if (!Number.isFinite(d) || d <= 0 || d > 24 * 3600 * 1000) return null;
  const cat = String(category == null ? '' : category).trim().slice(0, 80);
  if (!cat) return null;
  return { date, category: cat, durationMs: Math.round(d) };
}

async function apiAddSession(request, env, uid) {
  const body = await request.json().catch(() => null);
  const { date, category, durationMs, startedAt } = body || {};
  const v = validSession(date, category, durationMs);
  if (!v) return json({ error: 'invalid session' }, 400);
  const at = Number.isFinite(Number(startedAt)) ? Number(startedAt) : Date.now();
  await env.DB.prepare(
    'INSERT OR IGNORE INTO sessions (uid, date, category, duration_ms, started_at) VALUES (?, ?, ?, ?, ?)'
  ).bind(uid, v.date, v.category, v.durationMs, at).run();
  return json({ ok: true });
}

async function apiPutCategories(request, env, uid) {
  const body = await request.json().catch(() => null);
  const { categories } = body || {};
  if (!Array.isArray(categories)) return json({ error: 'invalid body' }, 400);
  const stmts = [env.DB.prepare('DELETE FROM categories WHERE uid = ?').bind(uid)];
  categories.forEach((name, idx) => {
    if (typeof name === 'string' && name.trim()) {
      stmts.push(env.DB.prepare('INSERT INTO categories (uid, name, position) VALUES (?, ?, ?)').bind(uid, name.trim(), idx));
    }
  });
  await env.DB.batch(stmts);
  return json({ ok: true });
}

async function apiPutSetting(request, env, uid) {
  const body = await request.json().catch(() => null);
  const { key, value } = body || {};
  if (!key) return json({ error: 'invalid body' }, 400);
  await env.DB.prepare(
    'INSERT INTO settings (uid, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(uid, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  ).bind(uid, key, JSON.stringify(value), Date.now()).run();
  return json({ ok: true });
}

// Blobs versionados por carimbo lógico (o cliente manda _stamps por blob)
const VERSIONED_BLOBS = new Set(['tasks', 'events', 'weekPlan', 'goals', 'alarms', 'h2Plan', 'target']);

async function apiBulkSync(request, env, uid) {
  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'invalid json' }, 400);
  const { sessions, categories, settings } = body || {};

  const stmts = [];

  // Sessions: INSERT OR IGNORE (dedupe via UNIQUE index uid+started_at+category)
  if (sessions && typeof sessions === 'object') {
    for (const date in sessions) {
      const list = sessions[date];
      if (!Array.isArray(list)) continue;
      for (const s of list) {
        const v = s && validSession(date, s.category, s.durationMs);
        const at = s && Number.isFinite(Number(s.at)) ? Number(s.at) : null;
        if (v && at) {
          stmts.push(env.DB.prepare(
            'INSERT OR IGNORE INTO sessions (uid, date, category, duration_ms, started_at) VALUES (?, ?, ?, ?, ?)'
          ).bind(uid, v.date, v.category, v.durationMs, at));
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

  // Settings. Blob versionado só é escrito se o carimbo que chega for ESTRITAMENTE maior
  // que o guardado — e essa decisão é ATÔMICA em SQL (WHERE no DO UPDATE compara a linha
  // existente), sem read-modify-write. Isso fecha o TOCTOU do gate anterior (que lia _stamps
  // num SELECT à parte → dois pushes concorrentes revertiam a edição um do outro). O carimbo
  // mora na coluna `stamp`; o mapa _stamps é DERIVADO dela no snapshot (sempre consistente
  // com os valores). O empate (inc==cur) não sobrescreve → device vazio não apaga dado real.
  // Valor idêntico não rebumpa updated_at (senão todo push acordava o pull de todos
  // os devices via serverStamp = MAX(updated_at) sem nada ter mudado)
  const upsertBlind = (key, value) => env.DB.prepare(
    'INSERT INTO settings (uid, key, value, updated_at, stamp) VALUES (?, ?, ?, ?, 0) ON CONFLICT(uid, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at ' +
    'WHERE settings.value IS NOT excluded.value'
  ).bind(uid, key, JSON.stringify(value), Date.now());
  // activeTimer: LWW pelo updatedAt DO ESTADO (não pela ordem de chegada) — push atrasado
  // de estado velho não pode calar uma pausa/parada mais nova. COALESCE cobre legado sem campo.
  const upsertActiveTimer = (value) => env.DB.prepare(
    'INSERT INTO settings (uid, key, value, updated_at, stamp) VALUES (?, ?, ?, ?, 0) ON CONFLICT(uid, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at ' +
    "WHERE COALESCE(json_extract(excluded.value, '$.updatedAt'), 0) >= COALESCE(json_extract(settings.value, '$.updatedAt'), 0)"
  ).bind(uid, 'activeTimer', JSON.stringify(value), Date.now());
  const upsertVersioned = (key, value, stamp) => env.DB.prepare(
    'INSERT INTO settings (uid, key, value, updated_at, stamp) VALUES (?, ?, ?, ?, ?) ' +
    'ON CONFLICT(uid, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, stamp = excluded.stamp ' +
    'WHERE excluded.stamp > settings.stamp'
  ).bind(uid, key, JSON.stringify(value), Date.now(), stamp);
  if (settings && typeof settings === 'object') {
    const incStamps = (settings._stamps && typeof settings._stamps === 'object') ? settings._stamps : {};
    for (const key in settings) {
      if (key === '_stamps') continue; // não é gravado: derivado da coluna stamp no snapshot
      if (VERSIONED_BLOBS.has(key)) stmts.push(upsertVersioned(key, settings[key], Number(incStamps[key]) || 0));
      else if (key === 'activeTimer') stmts.push(upsertActiveTimer(settings[key]));
      else stmts.push(upsertBlind(key, settings[key]));
    }
  }

  if (stmts.length > 0) await env.DB.batch(stmts);

  const snap = await loadFullSnapshot(env, uid);
  return json(snap);
}
