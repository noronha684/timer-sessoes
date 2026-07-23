# Publicar o Timer de Sessões na Microsoft Store — passo a passo

## 0. O que já está pronto neste repo
- `npm run dist:store` → gera `dist/Timer-de-Sessoes-<versão>-x64.appx` (assets de tile em `build/appx/` gerados na hora pelo `make-appx-assets.js`).
- Identidade no `package.json` (`build.appx`): `identityName: XPAsset.productivyislife`, `publisher: CN=7D2A6A52-0E8D-4771-AFE4-424AB6A0597F`, `publisherDisplayName: GabrielNoronha`.
- Política de privacidade já no ar: **https://timer.gnoronha.app/privacy.html** (a Store exige a URL).
- O pacote NÃO precisa de assinatura local — a Store assina na certificação. Só precisa que a identidade acima BATA com o Partner Center.

## 1. Conta de desenvolvedor (uma vez só)
1. https://partner.microsoft.com/dashboard → entrar com conta Microsoft.
2. Registrar como desenvolvedor **individual** (taxa única ~US$19, cartão internacional).
3. Verificação pode levar de minutos a 1-2 dias.

## 2. Reservar o app e conferir a identidade
1. Partner Center → **Apps and games** → **+ New product** → **App (MSIX/PWA)** → reservar o nome **"Timer de Sessões"** (o nome fica teu por 3 meses antes da 1ª submissão).
2. Dentro do produto → **Product management → Product identity**. Anotar os 3 valores:
   - `Package/Identity/Name` → vai em `identityName`
   - `Package/Identity/Publisher` → vai em `publisher`
   - `Package/Properties/PublisherDisplayName` → vai em `publisherDisplayName`
3. **Conferir com o `desktop/package.json`** (bloco `build.appx`). Se qualquer um divergir, corrigir o package.json e rebuildar — identidade errada = upload rejeitado na hora (o erro do Partner Center mostra os valores certos; é só copiar).

## 3. Gerar o pacote
```bash
cd desktop && npm run dist:store
```
Saída: `desktop/dist/Timer-de-Sessoes-<versão>-x64.appx`. A cada atualização futura: bump de `version` no package.json → rebuild → nova submissão (a Store exige versão crescente).

## 4. Submissão (Partner Center → teu app → Start submission)
Preencher os blocos, em qualquer ordem:

1. **Pricing and availability**: Free; mercados (todos, ou só Brasil); visibilidade pública.
2. **Properties**: categoria **Productivity**; Privacy policy URL: `https://timer.gnoronha.app/privacy.html`; website `https://timer.gnoronha.app`.
3. **Age ratings**: questionário IARC — sem conteúdo sensível em tudo → classificação livre.
4. **Packages**: upload do `.appx`. Device family: Desktop.
5. **Store listings** (pt-BR):
   - Descrição (sugestão): "Timer de foco com metas, histórico e sincronização entre dispositivos. Sessões de estudo e trabalho com plano semanal, calendário, integração de sono e modo flutuante sempre visível."
   - **Screenshots: mínimo 1** (recomendado 3-4), tirar do app real ≥1366×768 (Win+Shift+S na janela maximizada): timer rodando, aba Plano, flutuante sobre outra janela, Histórico com heatmap.
6. **Notes for certification** (IMPORTANTE — o app exige login):
   - Explicar: "App requires sign-in. Test account: <email> / <senha>".
   - **Pré-requisito**: ativar o provider **E-mail/senha** no console do Firebase (Authentication → Sign-in method), criar uma conta de teste, e adicionar o uid dela em `ALLOWED_UIDS` (`wrangler secret put ALLOWED_UIDS -c wrangler.api.jsonc`) — senão o testador da Microsoft não passa do portão e o app é REPROVADO.
7. **Submit** → certificação leva de horas a ~3 dias úteis. Reprovou? O relatório diz o motivo; corrige e re-submete.

## 5. Depois de aprovado
- O app aparece na Store em algumas horas; instalação/updates viram responsabilidade da Store (usuário atualiza pela Store, mas o SITE dentro do app continua se atualizando sozinho a cada deploy — só mudanças na CASCA exigem nova submissão).
- Link direto pra divulgar: `https://apps.microsoft.com/detail/<ProductId>` (o ProductId aparece no Partner Center).

## Reprovação de 23/jul/26 e o fix (1.0.8)
Relatório: "Unusable Feature: The sign in with Google option does not work". Causa: o Google bloqueia
browsers embutidos por heurística — UA disfarçado passou na máquina do dono e falhou no laboratório.
Fix definitivo (1.0.8 + site v149): o clique em "Entrar com Google" na casca abre o **navegador do
sistema** em `https://timer.gnoronha.app/auth-bridge?port=<loopback>&state=<nonce>`; a ponte faz
signInWithRedirect com o Google no browser real, devolve o ID token via POST pro loopback
(127.0.0.1, uso único, nonce, 5 min), e a casca finaliza com `window.__timerGoogleCredential`
(signInWithCredential) dentro do app. CSP do `_headers` precisou de `http://127.0.0.1:*` no
connect-src. Na resubmissão, escrever em Notes for certification: o Google agora abre o navegador
padrão (comportamento esperado) E fornecer a conta de teste e-mail/senha.

## Ciladas conhecidas
- **Identidade divergente** = erro no upload (ver passo 2.3).
- **"Abrir com o Windows"** roda diferente sob MSIX (registro virtualizado) — se falhar na versão da Store, é limitação conhecida do empacotamento, não regressão da casca.
- A versão NSIS (Setup .exe) e a da Store podem conviver instaladas — são identidades diferentes; recomendável desinstalar uma delas pra não ter dois na bandeja.
- Testar o `.appx` localmente ANTES da Store exige assinatura própria (não vale a pena) — o caminho é validar pela NSIS (mesmo código) e mandar pra certificação.
