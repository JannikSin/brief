// Decommissioned. This worker unregisters itself and clears every brief cache,
// so an installed home-screen copy stops serving the old app and falls through
// to the moved note. The credential fallback (brief.key) is gone with app.js.
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith("brief")).map((k) => caches.delete(k)));
    await self.registration.unregister();
    const clients = await self.clients.matchAll({ type: "window" });
    clients.forEach((c) => c.navigate(c.url));
  })());
});
