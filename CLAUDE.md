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
- **Ao mudar o app, SEMPRE bumpar `CACHE_NAME`** em `public/service-worker.js` (é stale-while-revalidate + auto-reload). Versão atual: **v98**.
- Segredo da API: `wrangler secret put WHOOP_CLIENT_SECRET -c wrangler.api.jsonc` (já setado; `wrangler deploy` preserva secrets).
- Rollback rápido da API: `wrangler rollback -c wrangler.api.jsonc`.

## Autenticação / segurança (feito em jul/2026)
- **Portão de login** (`#authGate` no `index.html`): o app só abre autenticado (e-mail/senha via Firebase **ou** Google). `body.authed` esconde o portão.
- **API valida o ID token do Firebase**: todo `/api/*` (exceto `/api/ping`) exige `Authorization: Bearer <idToken>`. O Worker verifica o JWT (RS256 contra a JWKS do Google), e usa **sempre `payload.sub` como uid** — ignora uid vindo de body/query (fecha IDOR). Cliente anexa o token via `authHeaders()`.
- Whoop connect: `POST /api/whoop/connect` (Bearer) devolve a URL de autorização — o token **não** vai na URL.
- Chip de conta no topo (`#accountChip`) mostra quem está logado; clique abre o painel de conta (`#syncModal`) com "Sair da conta" (signOut → volta pro portão). O sync é 100% automático (push debounced a cada save, pull ao abrir/voltar + polling 30s) — não existe mais botão "Sincronizar agora", login dentro do modal nem código manual (jul/2026); conexões legadas por código manual seguem funcionando sem UI.

## Convenções e ciladas (não repetir)
- **Verificar visualmente com Chrome headless**, não com o preview (screenshots do preview travam por causa do Firebase):
  `"/c/Program Files/Google/Chrome/Application/chrome.exe" --headless=new --disable-gpu --force-device-scale-factor=2 --window-size=460,900 --screenshot=OUT.png "file:///.../public/index.html"`
- **Checar sintaxe antes de deployar**: `node --check` no worker.js; nos scripts inline do index.html, extrair e `new Function(code)`.
- `.assetsignore` **não funciona** quando o dir de assets é a raiz → por isso `public/` (mantém `.git`/`worker.js` fora do ar).
- **oklch()** funciona em CSS mas **não** no canvas de WebView Android antigo → usar hex em `strokeStyle`/`fillStyle`.
- Tema: **Monólito** (jul/2026, Claude Design "App Monólito.html") — monocromático editorial: fundo `#0d0d0e`, creme `#f2f2f0` como único destaque, hairlines `rgba(255,255,255,0.08)`, textos `#8a8a90`/`#5b5b62`, seções flat separadas por hairline (sem cards), abas texto com sublinhado, pílulas outline (ativa = creme com texto escuro), numerais gigantes em Hanken 200. Fontes: **Hanken Grotesk** (app) e **IBM Plex Serif/Mono** (aba Semestre). Implementado como camada de override no fim do CSS ("MONÓLITO"); a camada champagne antiga ficou abaixo (morta). NÃO reintroduzir cor viva — semânticas (status/tiers) usam versões dessaturadas (#9ad0a5/#d9c58a/#e0a19b). Categorias de sessão = escala de cinza (`CATEGORY_COLORS`).
- Firebase: domínio novo precisa entrar nos **Authorized domains**; **e-mail/senha** exige ativar o provider no console (Authentication → Sign-in method).
- **"App não abre"** costuma ser **cache de DNS do roteador local** (abre no 4G), não a Cloudflare.

## Pendências conhecidas
- Ativar **Email/Password** no console do Firebase (Google já funciona).
- Confirmar o caminho positivo do token (login real → sync funciona); só o dono consegue testar (não dá pra emitir token sem provider habilitado).
- Subcategorias de sessão ainda não vão pro D1 (coluna ausente em `sessions`).
