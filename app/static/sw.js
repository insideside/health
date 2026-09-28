// Service Worker «Тренера»: оболочка приложения офлайн. Данные живут в IndexedDB (store.js),
// сюда не попадают. BUILD_HASH подставляет сервер — новый билд = новый воркер = новый кэш.
var CACHE = 'app-BUILD_HASH';
var ASSETS = ['/', '/app.js', '/store.js', '/coach.js', '/names.js', '/plan.js', '/ui.js', '/app.css', '/ui-a.css', '/ui-b.css', '/ui-c.css', '/accents.css', '/foods.js', '/normslocal.js', '/mealplan.js', '/goals.js', '/brain.js', '/foodparse.js', '/analysis.js', '/stenogramma.css', '/theme.js',
  '/views/today.js', '/views/calendar.js', '/views/food.js', '/views/workout.js', '/views/progress.js', '/views/profile.js', '/views/chat.js', '/views/together.js', '/views/health.js', '/views/about.js', '/views/install.js', '/qrcode.js', '/views/connect.js', '/prefs.js', '/views/fit.js', '/supps.js', '/views/supp.js'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) {
    return c.addAll(ASSETS);
  }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (names) {
    var stale = names.filter(function (n) { return n.indexOf('app-') === 0 && n !== CACHE; });
    return Promise.all(stale.map(function (n) { return caches.delete(n); })).then(function () { return stale.length > 0; });
  }).then(function (wasUpdate) {
    return self.clients.claim().then(function () {
      // страница отдаётся из кэша сразу, поэтому после обновления сервера открытые вкладки
      // показывали бы старую сборку — просим их перезагрузиться (только при обновлении)
      if (!wasUpdate) return;
      return self.clients.matchAll({ type: 'window' }).then(function (list) {
        list.forEach(function (c) { c.postMessage({ action: 'reload' }); });
      });
    });
  }));
});

var OFFLINE_PAGE = '<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Сервер недоступен</title></head>' +
  '<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#141311;color:#d2c9b6;font:16px/1.5 Georgia,serif">' +
  '<div style="max-width:340px;padding:24px;text-align:center"><h2 style="color:#e9e1d0;margin:0 0 10px">Сервер недоступен</h2>' +
  '<p id="s" style="color:#756d60;font-style:italic;font-size:14px">Жду подключения…</p>' +
  '<button onclick="location.reload()" style="padding:9px 18px;border:0;border-radius:6px;background:#d4705a;color:#fff7ee;font:700 12px sans-serif;letter-spacing:.08em;text-transform:uppercase">Попробовать</button>' +
  '<p style="color:#756d60;font-size:13px;margin-top:22px">Сменился адрес компьютера? Укажите его:</p>' +
  '<form onsubmit="var v=this.h.value.trim();if(v){if(v.indexOf(\'://\')<0)v=\'https://\'+v;if(!/:\\d+$/.test(v))v+=\':8790\';location.href=v+\'/\'}return false">' +
  '<input name="h" placeholder="192.168.1.50" style="width:100%;box-sizing:border-box;padding:9px;border-radius:6px;border:1px solid #3a352d;background:#181714;color:#d2c9b6"></form>' +
  // известные зеркала кладёт сюда store.js (localStorage 'trainer_mirrors'): IndexedDB отсюда читать неудобно
  '<div id="m"></div></div>' +
  '<script>try{var ms=JSON.parse(localStorage.getItem("trainer_mirrors")||"[]");if(ms.length){var box=document.getElementById("m");box.innerHTML=\'<p style="color:#756d60;font-size:13px;margin:22px 0 8px">Или откройте другой адрес этого сервера:</p>\';ms.slice(0,6).forEach(function(u){if(!/^https?:\\/\\//.test(u))return;var b=document.createElement("button");b.textContent=u.replace(/^https?:\\/\\//,"");b.style.cssText="display:block;width:100%;margin:6px 0;padding:9px;border:1px solid #3a352d;border-radius:6px;background:#1d1b18;color:#d2c9b6;font:13px monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";b.onclick=function(){location.href=u+"/"};box.appendChild(b)})}}catch(e){}' +
  'var t=0;setInterval(function(){t++;document.getElementById("s").textContent="Жду подключения… ("+t+")";fetch("/api/version",{cache:"no-store"}).then(function(r){return r.json()}).then(function(d){if(d&&d.version)location.reload()}).catch(function(){})},2000)</script></body></html>';

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  if (url.origin !== self.location.origin || e.request.method !== 'GET') return;
  // иконки, манифест и сертификат запрашивает система, а не страница: подменённый ответ
  // оставил бы iPhone без значка на экране «Домой»
  if (url.pathname === '/manifest.json' || url.pathname.indexOf('/icon') === 0 ||
      url.pathname.indexOf('/apple-touch-icon') === 0 || url.pathname.indexOf('/favicon') === 0 || url.pathname === '/ca.crt' || url.pathname === '/sw.js') return;

  if (url.pathname.indexOf('/api/') === 0) {
    e.respondWith(fetch(e.request).catch(function () {
      return new Response(JSON.stringify({ error: 'offline' }), { status: 503, headers: { 'Content-Type': 'application/json' } });
    }));
    return;
  }

  // оболочка: сразу из кэша, свежая версия — в фоне (stale-while-revalidate)
  var key = e.request.mode === 'navigate' ? '/' : url.pathname;
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(key).then(function (cached) {
      var net = fetch(e.request).then(function (resp) {
        if (resp.ok && ASSETS.indexOf(key) >= 0) cache.put(key, resp.clone());
        return resp;
      });
      if (cached) { net.catch(function () {}); return cached; }
      return net.catch(function () {
        return key === '/' ? new Response(OFFLINE_PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } })
                           : new Response('', { status: 504 });
      });
    });
  }));
});
