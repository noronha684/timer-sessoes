# Timer de Sessões

App pessoal de foco (estilo Windows Focus Sessions) para acompanhar horas de estudo (CFA) e trabalho, com sono, agenda, calendário, diário de hábitos e metas. PWA instalável.

**No ar:** https://timer.gnoronha.app

> **Trabalhando no código (com Claude ou não)?** Leia **[`CLAUDE.md`](CLAUDE.md)** — estado atual, deploy por `wrangler` e ciladas. Deploy mudou em jul/2026: **não é mais `git push`**.

---

## Arquitetura

| Camada | Onde | Detalhe |
|---|---|---|
| **App (frontend)** | Worker **`timer-app`** (static assets) | Serve `./public/` (`index.html` = app inteiro num arquivo só). Domínio `timer.gnoronha.app`. Deploy: `wrangler deploy`. |
| **API** | Cloudflare Worker `timer-sessoes` | `worker.js` — REST `/api/*` + OAuth do Whoop. Deploy: `wrangler deploy -c wrangler.api.jsonc`. |
| **Banco** | Cloudflare D1 `timer-sessoes` | id `63f9fce0-a3e3-4e68-87ef-3390c40babdc`. Tabelas: `sessions`, `categories`, `settings`, `whoop_tokens`, `oauth_states`. |
| **Login/Auth** | Firebase Auth (projeto `timer-sessoes`) | Google + e-mail/senha. **Login obrigatório** (portão de entrada). UID = chave de dados. A API valida o ID token (Bearer). |
| **Sono** | Whoop API v2 | OAuth via Worker; importa duração + início/fim do sono. |

Domínio `gnoronha.app` (Cloudflare Registrar) é guarda-chuva: `timer.`, `adega.` (wineislife), `finance.` (organizador), `bbce.` etc.

---

## Como funciona o sync
- Cada dispositivo tem um `DEVICE_ID`. A chave de sync (`syncCode`) é o **UID do Google** (ou um código manual, fallback).
- Dados salvam **primeiro no localStorage** (instantâneo), depois sobem pro D1 via `POST /api/sync`.
- O merge é **não-destrutivo**: sessões dedupadas por `(at, category, durationMs)`; history recomputado das sessões; categorias por união. Nunca apaga com vazio.
- Pull automático ao abrir e a cada 30s. Push imediato ao registrar sessão.
- **Timer ativo** espelha entre dispositivos (banner read-only "em andamento em outro dispositivo").

## Abas
Timer · Histórico (gráficos 7/30/60d) · Sono (manual + Whoop) · Agenda (timeline semanal) · Calendário (planner mês/semana) · Diário (hábitos customizáveis).
Extras no Timer: metas mensais (anel de meta diária por dias úteis + marcador de ritmo), burn-down até a prova, sessão manual, modo flutuante (PiP com anel).

---

## Deploy (por `wrangler`, direto — sem GitHub)

```bash
wrangler deploy                        # app  → timer.gnoronha.app
wrangler deploy -c wrangler.api.jsonc  # API  (só quando mexer no worker.js)
```
O GitHub **não deploya** (Workers Builds desconectado) — é só backup. Service worker é **stale-while-revalidate** + auto-reload, então o app atualiza sozinho na próxima abertura; **bumpar `CACHE_NAME` em `public/service-worker.js` a cada mudança do app**. Secret da API: `wrangler secret put WHOOP_CLIENT_SECRET -c wrangler.api.jsonc` (deploy preserva secrets). Rollback da API: `wrangler rollback -c wrangler.api.jsonc`.

---

## ⚠️ Perrengues conhecidos (não repetir)
- **Publicar só a pasta `public/`** — `worker.js`, `.git`, configs ficam na raiz e **não** vão pro ar (o `wrangler.jsonc` aponta assets pra `./public`). Isso corrigiu o `.git` que já vazou público. (`.assetsignore` não resolve quando o dir de assets é a raiz — por isso `public/`.) O `worker.js` agora é **rastreado** no git.
- **Domínio novo no Firebase:** ao usar um endereço novo (ex: workers.dev), adicionar em Firebase → Authentication → Settings → Authorized domains, senão login dá `auth/unauthorized-domain`.
- **"App não abre" / timeout:** geralmente cache de DNS do roteador local (funciona no 4G). Reiniciar roteador ou usar DNS `1.1.1.1`. Não é o Cloudflare.
- **Subcategorias** sincronizam pelo D1 desde a migração 0001_add_session_subcategory.sql; sessões antigas são preenchidas no próximo push de um dispositivo que ainda tenha esse detalhe local.
- **Não misturar** login Google + código manual de sync (cria "contas" paralelas no D1).

## Queries D1 úteis (via painel)
```sql
SELECT date, category, SUM(duration_ms)/60000 min FROM sessions WHERE uid='<uid>' GROUP BY date,category ORDER BY date DESC;
```
