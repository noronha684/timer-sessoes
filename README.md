# Timer de Sessões

App pessoal de foco (estilo Windows Focus Sessions) para acompanhar horas de estudo (CFA) e trabalho, com sono, agenda, calendário, diário de hábitos e metas. PWA instalável.

**No ar:** https://timer.gnoronha.app (e o endereço direto https://timer-app.gabriel-noronha-o-p.workers.dev)

---

## Arquitetura

| Camada | Onde | Detalhe |
|---|---|---|
| **Frontend** | Cloudflare Pages/Worker `timer-app` | Arquivo único `index.html` (HTML+CSS+JS inline). Deploy automático no `git push` deste repo. |
| **API** | Cloudflare Worker `timer-sessoes` | `worker.js` — REST `/api/*` + OAuth do Whoop. Deploy **manual** (colar no painel). |
| **Banco** | Cloudflare D1 `timer-sessoes` | id `63f9fce0-a3e3-4e68-87ef-3390c40babdc`. Tabelas: `sessions`, `categories`, `settings`, `whoop_tokens`, `oauth_states`. |
| **Login/Auth** | Firebase Auth (projeto `timer-sessoes`) | Só Google Sign-In. O UID do Google é a chave de sincronização. |
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

## Deploy

**Frontend (automático):**
```bash
git add -A && git commit -m "..." && git push
```
Cloudflare Pages re-deploya em ~1min. Service worker é **stale-while-revalidate** + auto-reload (`controllerchange`), então o app atualiza sozinho na próxima abertura. Bumpar `CACHE_NAME` no `service-worker.js` a cada mudança.

**API/Worker (manual):** colar `worker.js` no painel do Worker `timer-sessoes` → Deploy. Binding `DB` → D1 `timer-sessoes`. Secrets: `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET`.

---

## ⚠️ Perrengues conhecidos (não repetir)
- **`worker.js` NÃO pode estar no repo do frontend** — o Cloudflare detecta e quebra o deploy (404). Está no `.gitignore`. Mantido local só pra referência; a API é deployada manual no Worker `timer-sessoes`.
- **Domínio novo no Firebase:** ao usar um endereço novo (ex: workers.dev), adicionar em Firebase → Authentication → Settings → Authorized domains, senão login dá `auth/unauthorized-domain`.
- **"App não abre" / timeout:** geralmente cache de DNS do roteador local (funciona no 4G). Reiniciar roteador ou usar DNS `1.1.1.1`. Não é o Cloudflare.
- **Subcategorias** ainda não vão pro D1 (tabela `sessions` não tem a coluna). Salvam local; corrigir no worker depois (ALTER TABLE + INSERT).
- **Não misturar** login Google + código manual de sync (cria "contas" paralelas no D1).

## Queries D1 úteis (via painel)
```sql
SELECT date, category, SUM(duration_ms)/60000 min FROM sessions WHERE uid='<uid>' GROUP BY date,category ORDER BY date DESC;
```
