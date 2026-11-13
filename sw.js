// PIANO STUDIO — Service Worker
//
// 策略：network-first（先联网，拿到就用新的；断网才回退缓存）
//
// 为什么不是 cache-first：本应用是「边开发边用」的，页面脚本和样式经常变。
// 旧版实现是「先查缓存、命中就直接返回」，只要 sw.js 本身没改过，浏览器就
// 不会重装 SW、也不会清缓存，于是本地服务器上明明已经是新代码，浏览器里
// 却一直显示旧界面（改完必须手动改 CACHE 版本号才会失效）。
// 现在改成：每次请求优先走网络并顺手更新缓存，离线时才用缓存兜底，
// 既保留可安装 / 离线可用的能力，又不会卡住更新。
//
// CACHE 版本号的作用变成「强制丢弃离线副本」：升级到不兼容的改动、
// 或想手动清掉旧缓存时，改这个字符串即可（activate 里会删掉其它版本）。

const CACHE = 'piano-studio-v1.13.2';
const SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './version.js',
  './manifest.webmanifest',
  './icon-64.png',
  './icon-192.png',
  './lib/vexflow.js',
  './lib/vexflow-bravura.js',
  './lib/lame.min.js'
];

// 离线时导航请求的兜底页面
const OFFLINE_PAGE = './index.html';

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache =>
      // 逐个加入并各自兜住失败：某个资源缺失不应该让整个 SW 装不上
      // （addAll 是全有或全无，缺一个就整体失败，反而会永远停在旧版本）
      Promise.all(SHELL.map(url =>
        cache.add(url).catch(() => {})
      ))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;

  // 只接管同源的 GET；POST / 跨域（比如 GitHub API）一律放行给网络
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;

  // Range 请求（音视频拖动）不缓存，避免存下半截内容
  const hasRange = request.headers.has('range');

  event.respondWith(
    fetch(request, { cache: 'no-store' })
      .then(response => {
        if (response && response.ok && response.type === 'basic' && !hasRange) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      })
      .catch(() =>
        // 网络失败（离线 / 服务器没开）才走缓存
        caches.match(request).then(cached => {
          if (cached) return cached;
          if (request.mode === 'navigate') {
            return caches.match(OFFLINE_PAGE).then(shell => shell || offlineResponse());
          }
          return offlineResponse();
        })
      )
  );
});

function offlineResponse() {
  return new Response('当前处于离线状态，且没有可用的缓存副本。', {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' }
  });
}
