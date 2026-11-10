/**
 * Service Worker - سامانه ثبت گراف مدیریت اتوماسیون و ارتباطات
 * طراحی شده برای کارکرد ۱۰۰٪ آفلاین بر روی اندروید، ویندوز و مرورگرهای مدرن (PWA)
 */

// نسخه سراسری پروژه - با تغییر این متغیر، اپلیکیشن‌های نصب‌شده قدیمی نسخه جدید را شناسایی و ارتقا می‌دهند
var APP_VERSION = '3.1.0';
var CACHE_NAME = `automation-graph-pwa-v${APP_VERSION}`;
var CORE_ASSETS = [
  '/',
  '/index.html',
  '/app.js',
  '/manifest.json',
  '/version.json',
  '/xlsx.full.min.js',
  '/personnel-data.json',
  '/personnel-data.js',
  '/app-logo.png',
  '/icon.png',
  '/icon.svg',
  '/icon-192.png',
  '/icon-512.png',
  '/icon-maskable-192.png',
  '/icon-maskable-512.png',
  '/apple-touch-icon.png'
];

// نصب و ذخیره اولیه دارایی‌های اصلی
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const asset of CORE_ASSETS) {
        try {
          await cache.add(asset);
        } catch (err) {
          console.warn('[SW] Caching asset note:', asset, err);
        }
      }
    }).then(() => self.skipWaiting())
  );
});

// فعال‌سازی و پاک‌سازی کامل تمام نسخه‌های قبلی کش
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Cleaning old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// استراتژی پاسخ‌دهی هوشمند: Network-First برای اسکریپت‌ها و ساختار HTML، و Cache-First برای تصاویر
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);

  // برای فایل‌های کد (JS, HTML) و ناوبری: ابتدا شبکه، در صورت قطعی اینترنت کش محلی (Network-First)
  if (
    event.request.mode === 'navigate' ||
    url.pathname.endsWith('.js') ||
    url.pathname.endsWith('.html') ||
    url.pathname === '/'
  ) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match(event.request, { ignoreSearch: true });
          if (cached) return cached;
          if (event.request.mode === 'navigate') {
            return (await caches.match('/index.html', { ignoreSearch: true })) || (await caches.match('/', { ignoreSearch: true }));
          }
          return (await caches.match('/app.js', { ignoreSearch: true }));
        })
    );
    return;
  }

  // برای سایر فایل‌ها (تصاویر، آیکون‌ها): Network-First جهت دریافت سریع آخرین آیکون و سپس کش آفلاین
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const copy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return networkResponse;
      })
      .catch(async () => {
        const cached = await caches.match(event.request, { ignoreSearch: true });
        if (cached) return cached;
        if (event.request.destination === 'image' || url.pathname.match(/\.(png|jpg|jpeg|svg|webp|ico)$/i)) {
          return (await caches.match('/app-logo.png', { ignoreSearch: true })) ||
                 (await caches.match('/icon.png', { ignoreSearch: true })) ||
                 (await caches.match('/icon-192.png', { ignoreSearch: true })) ||
                 (await caches.match('/icon.svg', { ignoreSearch: true }));
        }
        return new Response('', { status: 408, statusText: 'Offline Asset Unavailable' });
      })
  );
});

// دریافت پیام پرش از انتظار جهت بروزرسانی آنی
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
