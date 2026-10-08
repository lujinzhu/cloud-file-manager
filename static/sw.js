/* 云文件管理器 - Service Worker（用于 PWA 安装 & 离线壳） */
const CACHE = "cfm-v1";
const ASSETS = [
  "/", "/style.css", "/app.js", "/manifest.json",
  "/icon.svg", "/icon-192.png", "/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((ks) =>
      Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // 接口永远走网络
  // 静态资源：缓存优先，失败回源
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});
