// Stub de auth + API pro harness de smoke (roda ANTES dos scripts do app).
// - Desliga o Firebase real (firebaseConfig=null → o módulo de init vira no-op)
// - window._fb fake: usuário logado na hora (o portão abre via onAuthStateChanged)
// - fetch mockado pra API (nenhuma chamada de rede sai do teste)
(function () {
  window.firebaseConfig = null; // init real do Firebase pula (checa apiKey)

  const fakeUser = {
    uid: 'test-uid',
    email: 'smoke@test.local',
    displayName: 'Smoke Test',
    getIdToken: async () => 'test-token',
  };
  const authCbs = [];
  window._fb = {
    auth: { currentUser: fakeUser },
    onAuthStateChanged: (auth, cb) => { authCbs.push(cb); setTimeout(() => cb(fakeUser), 0); return () => {}; },
    signOut: async () => { window._fb.auth.currentUser = null; authCbs.forEach(cb => cb(null)); },
    GoogleAuthProvider: function () {},
    signInWithPopup: async () => ({ user: fakeUser }),
    signInWithRedirect: async () => {},
    createUserWithEmailAndPassword: async () => ({ user: fakeUser }),
    signInWithEmailAndPassword: async () => ({ user: fakeUser }),
    sendPasswordResetEmail: async () => {},
  };

  // Mock da API: responde o suficiente pro app abrir sem rede.
  const realFetch = window.fetch.bind(window);
  window.fetch = function (url, opts) {
    const u = String(url);
    const api = (path) => u.includes('/api/' + path);
    const ok = (obj) => Promise.resolve(new Response(JSON.stringify(obj), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    if (u.includes('/api/')) {
      if (api('whoami')) return ok({ uid: 'test-uid', owner: true });
      if (api('snapshot')) return ok({ unchanged: true, serverStamp: 1 });
      if (api('sync')) return ok({ sessions: {}, history: {}, categories: [], settings: { _stamps: {} }, serverStamp: 1, serverTime: Date.now() });
      if (api('whoop/status')) return ok({ connected: false });
      if (api('week-note')) return ok({ note: 'Reiteramos COMPRA na execução (stub).' });
      if (api('suggest-week')) return ok({ week: 1, reason: 'stub' });
      if (api('ping')) return ok({ ok: true, now: Date.now() });
      return ok({ ok: true });
    }
    return realFetch(url, opts);
  };
})();
