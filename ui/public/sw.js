// Agoryx's service worker: notifications only. It caches nothing and handles no requests — the page
// always comes from the daemon. A push carries only an id: what it says comes from the daemon, asked with
// this device's cookie, so a push the daemon did not send (anyone holding the keys can push) shows nothing.
// A tap opens the room.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const show = (note) =>
  self.registration.showNotification(note.title || "Agoryx", {
    body: note.body || "",
    tag: note.tag || undefined,
    renotify: Boolean(note.tag),
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    data: { room: note.room || null },
  });

self.addEventListener("push", (event) => {
  let id = "";
  try {
    id = String((event.data && event.data.json().id) || "");
  } catch {
    id = "";
  }
  if (!/^[\w-]{8,64}$/.test(id)) return;
  event.waitUntil(
    (async () => {
      let response;
      try {
        response = await fetch(`/api/push/note/${encodeURIComponent(id)}`, { credentials: "same-origin", cache: "no-store" });
      } catch {
        // The daemon cannot be reached from here right now: say only that something waits, never what.
        await show({ title: "Agoryx", body: "New notification — open Agoryx to see it.", tag: "agoryx-unverified" });
        return;
      }
      // Not the daemon's push (or not for this device, or this device was revoked): nothing is shown.
      if (!response.ok) return;
      await show(await response.json());
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const room = event.notification.data && event.notification.data.room;
  const hash = room ? `#${encodeURIComponent(room)}` : "";
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const page = open.find((client) => new URL(client.url).origin === self.location.origin);
      if (page) {
        await page.focus();
        page.postMessage({ type: "open-room", room });
        return;
      }
      await self.clients.openWindow(`/${hash}`);
    })(),
  );
});
