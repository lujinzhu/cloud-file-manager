/* 私人云盘 - Service Worker（PWA 离线壳）
   使用相对路径，兼容任意子路径部署（如 /yunpan/） */
const CACHE = "cfm-v7";
const ASSETS = [
  "./", "style.css", "app.js", "manifest.json",
  "icon.svg", "icon-192.png", "icon-512.png",
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
  const SCOPE = self.registration.scope;           // 当前部署子路径，如 "/yunpan/"
  if (!url.href.startsWith(SCOPE)) return;         // 只管自己作用域内的请求
  if (url.pathname.startsWith(SCOPE + "api/")) return; // 接口永远走网络
  // 静态资源：缓存优先，失败回源
  e.respondWith(
    caches.match(e.request).then((r) => r || fetch(e.request))
  );
});
