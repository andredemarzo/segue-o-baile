const CACHE_NAME = "copa-2026-alertas-v79";
// DADOS (data/*.json) NÃO entram no precache nem no cache do SW — são servidos SEMPRE da rede
// (ver o fetch handler). Cachear placar/grade serve dado velho como se fosse atual e fere a credibilidade.
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=79",
  "./app.js?v=79",
  "./manifest.webmanifest",
  "./assets/worldcup-mark.svg",
  "./assets/icon-192.png",
  "./assets/icon-512.png",
  "./assets/apple-touch-icon.png",
  "./assets/bell.svg",
  "./assets/check.svg",
  "./assets/calendar.svg",
  "./assets/fan.jpg"
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
      ),
      self.clients.claim()
    ])
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return; // ex.: API da FIFA passa direto, sem cache
  // DADOS (data/*.json: matches/broadcasts/today) SEMPRE da rede, NUNCA do cache do SW: placar/grade
  // velho disfarçado de atual fere a credibilidade — pior que "sem dado". Offline → a página mostra
  // "verifique a conexão" (honesto). Frescor > offline puro para um app de placar ao vivo.
  if (url.pathname.includes("/data/")) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
