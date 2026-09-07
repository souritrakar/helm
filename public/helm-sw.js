/* helm's notification-only service worker. It owns no cache or application state. */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
    const existing = clients[0];
    return existing ? existing.focus() : self.clients.openWindow("/");
  }));
});
