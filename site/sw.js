const CACHE_NAME = "copa-2026-alertas-v66";
const STATIC_ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=66",
  "./app.js?v=66",
  "./manifest.webmanifest",
  "./data/matches.json",
  "./data/broadcasts.json",
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
  if (new URL(event.request.url).origin !== self.location.origin) return; // ex.: API da FIFA passa direto, sem cache
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
