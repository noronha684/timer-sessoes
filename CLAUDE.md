# Timer de Sessões — guia para o Claude

App PWA pessoal de foco (CFA/trabalho) com histórico, metas, sono (Whoop), agenda, calendário e um dashboard semestral (OKRs). **No ar:** https://timer.gnoronha.app

> Este arquivo é a fonte de verdade para trabalhar no projeto. O `README.md` é para humanos e a seção de deploy dele pode estar defasada — **prevalece o que está aqui.**

## Arquitetura (tudo Cloudflare + Firebase Auth)

| Camada | Onde | Detalhe |
|---|---|---|
| **App (frontend)** | Worker **`timer-app`** (static assets) | Serve `./public/`. **NÃO é Pages.** Domínio próprio `timer.gnoronha.app`. |
| **API** | Worker **`timer-sessoes`** | `worker.js` — REST `/api/*` + OAuth Whoop. Em `timer-sessoes.gabriel-noronha-o-p.workers.dev`. |
| **Banco** | D1 **`timer-sessoes`** | id `63f9fce0-a3e3-4e68-87ef-3390c40babdc`. Tabelas: `sessions`, `categories`, `settings`, `whoop_tokens`, `oauth_states`. |
| **Login** | Firebase Auth, projeto `timer-sessoes` | Google + e-mail/senha. `apiKey` pública `AIzaSyBylkeEsWQYwOWMpDxFidBHejuE1PJCMNQ`. UID = chave de dados. |

## Layout do repositório
- `public/` → **os arquivos que vão pro ar** (`index.html` = app inteiro num arquivo só ~6900 linhas; `service-worker.js`; ícones; `manifest.json`; `privacy.html`).
- `worker.js` → código da API (Worker `timer-sessoes`).
- `wrangler.jsonc` → config do app (`timer-app`, assets `./public`, custom domain).
- `wrangler.api.jsonc` → config da API (`timer-sessoes`, binding D1, var `WHOOP_CLIENT_ID`).
- Raiz (worker.js, README, .git) **não** é publicada (só `public/`).

## Deploy (direto por wrangler — SEM GitHub)
```bash
wrangler deploy                        # app  → timer.gnoronha.app
wrangler deploy -c wrangler.api.jsonc  # API  (só quando mexer no worker.js)
```
- O GitHub **não deploya** nada (o Workers Builds foi desconectado). GitHub = backup do código.
- **Ao mudar o app, SEMPRE bumpar `CACHE_NAME`** em `public/service-worker.js` (é stale-while-revalidate + auto-reload). Versão atual: **v115**.
- O SW tem um **cache permanente `CDN_CACHE`** (fontes + Firebase SDK) que sobrevive a bumps — NÃO apagá-lo no activate (era isso que causava primeira abertura de 3–5 min pós-deploy: re-download de 3 CDNs com DNS de roteador ruim). Imutáveis (woff2/firebasejs) = cache-first puro; CSS do Google Fonts = stale-while-revalidate em modo CORS (opaque nunca entra). **Se mudar a versão do firebasejs no index.html, atualizar `FIREBASEJS_VER` no service-worker.js** (poda das versões velhas no activate).
- Segredos da API (todos já setados; `wrangler deploy` preserva): `WHOOP_CLIENT_SECRET`, `ANTHROPIC_API_KEY` (usado pelo `/api/suggest-week`; sem ele o endpoint responde 501) e `OWNER_UID` (trava a API ao uid do dono — outros uids levam 403). `wrangler secret put <NOME> -c wrangler.api.jsonc`.
- Rollback rápido da API: `wrangler rollback -c wrangler.api.jsonc`.

## Autenticação / segurança (feito em jul/2026)
- **Portão de login** (`#authGate` no `index.html`): o app só abre autenticado (e-mail/senha via Firebase **ou** Google). `body.authed` esconde o portão.
- **API valida o ID token do Firebase**: todo `/api/*` (exceto `/api/ping`) exige `Authorization: Bearer <idToken>`. O Worker verifica o JWT (RS256 contra a JWKS do Google), e usa **sempre `payload.sub` como uid** — ignora uid vindo de body/query (fecha IDOR). Cliente anexa o token via `authHeaders()`.
- Whoop connect: `POST /api/whoop/connect` (Bearer) devolve a URL de autorização — o token **não** vai na URL.
- Chip de conta no topo (`#accountChip`) mostra quem está logado; clique abre o painel de conta (`#syncModal`) com "Sair da conta" (signOut → volta pro portão). O sync é 100% automático (push debounced a cada save, pull ao abrir/voltar + polling 30s) — não existe mais botão "Sincronizar agora", login dentro do modal nem código manual (jul/2026); conexões legadas por código manual seguem funcionando sem UI.

## Multiusuário (jul/2026)
- **Gate:** `OWNER_UID` (dono) + `ALLOWED_UIDS` (convidados, uids separados por vírgula; `wrangler secret put ALLOWED_UIDS -c wrangler.api.jsonc`). `/api/whoami` (antes do gate) devolve `{uid, owner}`.
- **Não-dono** (`timerIsOwner='0'`, setado pelo whoami no `recomputeSyncCode`): H2_WEEKPLAN é MUTADO in place (`h2ApplyPlanConfig`) pra semanas GERADAS em branco — `planStart`/`planWeeks` no doc h2Plan (card "Configuração do plano" na aba Plano); aba Semestre oculta; categorias default genéricas. O plano-seed do dono fica em `H2_WEEKPLAN_SEED`. 1ª-semana-do-mês: plano gerado usa chave ano-mês; o seed mantém o recorte `m>=7` (NÃO mudar — realocaria recorrentes).
- 403 do gate → painel de conta mostra o uid pro convidado pedir acesso.

## Convenções e ciladas (não repetir)
- **Verificar visualmente com Chrome headless**, não com o preview (screenshots do preview travam por causa do Firebase):
  `"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --force-device-scale-factor=2 --window-size=460,900 --screenshot=OUT.png "file:///.../public/index.html"`
- **Checar sintaxe antes de deployar**: `node --check` no worker.js; nos scripts inline do index.html, extrair e `new Function(code)`.
- `.assetsignore` **não funciona** quando o dir de assets é a raiz → por isso `public/` (mantém `.git`/`worker.js` fora do ar).
- **oklch()** funciona em CSS mas **não** no canvas de WebView Android antigo → usar hex em `strokeStyle`/`fillStyle`.
- Tema: **Monólito** (jul/2026, Claude Design "App Monólito.html") — monocromático editorial: fundo `#0d0d0e`, creme `#f2f2f0` como único destaque, hairlines `rgba(255,255,255,0.08)`, textos `#8a8a90`/`#5b5b62`, seções flat separadas por hairline (sem cards), abas texto com sublinhado, pílulas outline (ativa = creme com texto escuro), numerais gigantes em Hanken 200. Fontes: **Hanken Grotesk** (app) e **IBM Plex Serif/Mono** (aba Semestre). Implementado como camada de override no fim do CSS ("MONÓLITO"); a camada champagne antiga ficou abaixo (morta). NÃO reintroduzir cor viva — semânticas (status/tiers) usam versões dessaturadas (#9ad0a5/#d9c58a/#e0a19b). Categorias de sessão = escala de cinza (`CATEGORY_COLORS`).
- Firebase: domínio novo precisa entrar nos **Authorized domains**; **e-mail/senha** exige ativar o provider no console (Authentication → Sign-in method).
- **"App não abre"** costuma ser **cache de DNS do roteador local** (abre no 4G), não a Cloudflare.
- **Tarefas ⊂ Plano (fusão jul/2026)**: não existe mais Hoje / A fazer / Concluídas — o card Tarefas é entrada única (nº de semana opcional; sem nº o `/api/suggest-week` sugere) + checklist da semana corrente (itens `wkit_<id>_<n>` no blob h2Plan). Pendências antigas no blob `tasks` **não migram sozinhas**: seção "Soltas do sistema antigo" com migração manual (dedupe por texto, categoria vira prefixo `[cat]`, uma escrita por blob). **Nunca reintroduzir migração automática em render** — roda dentro do apply do sync (push não agendado) e duplica itens quando o blob ressuscita por LWW.

## Sync (reescrito jul/2026 — blobs versionados)
- **Modelo:** cada blob deletável (tasks, events, weekPlan, goals, alarms, h2Plan, target) sincroniza por **last-writer-wins com carimbo LÓGICO (Lamport)** guardado em `timerStamps` + `timerStampClock`. `stampBlob()` gera valor sempre > tudo já visto (robusto a clock skew). No pull, `applyServerSnapshot` só aplica o blob do servidor se `srvStamps[name] > blobStamps[name]`. Exclusão propaga (o blob inteiro do último editor ganha). **Categorias, subcategorias, sono, segmentos, sessões = merge aditivo/união** (não versionados). História preserva dias legacy.
- **Push:** `sessionsDelta()` (só sessões com `at > lastPushedSessionAt`, não o histórico inteiro) + `settings._stamps`. **Pull:** `?since=lastServerStamp` → worker responde `{unchanged}` quando nada mudou. Flush no fechamento = `beaconPush()` (fetch keepalive síncrono com `_lastIdToken` em cache).
- **serverStamp** (worker) = `MAX(settings.updated_at)` só (relógio do servidor; NÃO usa `started_at` do cliente, que pode vir do futuro).
- **Timer ao vivo sincroniza** (jul/2026): `activeTimer` na settings — rodando = estado completo (`device`=dono, `by`=escritor, `sessionId` imutável); parado com tombstone = `{stopped, sessionId}`; parado sem = `undefined` (NÃO tocar a chave — era o clobber que matava o espelho). `applyRemoteTimer` adota/reconcilia/limpa; SÓ o dono grava segmentos; quem para salva a sessão (os outros recebem tombstone e não salvam); conclusão automática usa `at` determinístico (sessionId+duração) pra deduplicar no merge.
- **OWNER_UID já está setado** (jul/2026): a API só responde ao uid do dono; outros uids autenticados levam 403. `/api/whoami` fica antes do gate (serve pra descobrir o uid).

## Pendências conhecidas
- Ativar **Email/Password** no console do Firebase (Google já funciona).
- Confirmar o caminho positivo do token (login real → sync funciona); só o dono consegue testar (não dá pra emitir token sem provider habilitado).
- Subcategorias de sessão ainda não vão pro D1 (coluna ausente em `sessions`).
