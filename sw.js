// SkyCast service worker: keeps the app, fonts and the sky model on the phone so cloud
// recognition works offline. Forecast requests always go to the network.
const VERSION = "skycast-v2.2.0";
const SHELL = [
  "./", "index.html", "styles.css", "manifest.webmanifest",
  "js/app.js", "js/rain.js", "js/model.js", "js/sky.js", "js/log.js", "js/home.js",
  "vendor/ort/ort.wasm.min.js", "vendor/ort/ort-wasm-simd-threaded.mjs", "vendor/ort/ort-wasm-simd-threaded.wasm",
  "vendor/jszip.min.js",
  "fonts/atkinson-hyperlegible-latin-400-normal.woff2", "fonts/atkinson-hyperlegible-latin-700-normal.woff2",
  "fonts/archivo-latin-standard-normal.woff2",
  "model/labels.json", "model/skycast_phone.onnx",
  "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return; // Open-Meteo: network only
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((r) => {
      if (r.ok && r.type === "basic") {
        const copy = r.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return r;
    }).catch(() => caches.match("index.html")))
  );
});
