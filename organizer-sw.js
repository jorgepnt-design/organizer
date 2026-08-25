importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/9.23.0/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBBMU-KPmSzu0F9iFGV_AF049Aivtnx0S4",
  authDomain: "arbeitsapp-3364c.firebaseapp.com",
  projectId: "arbeitsapp-3364c",
  storageBucket: "arbeitsapp-3364c.firebasestorage.app",
  messagingSenderId: "202291981896",
  appId: "1:202291981896:web:0294b473eaff98a454b27d",
  measurementId: "G-7ZJCVC7TRZ"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const n = payload?.notification || {};
  const title = n.title || "Jorge Organizer";
  const body = n.body || "Neue Erinnerung";
  const icon = n.icon || "/organizer-icon-192.png";
  const clickAction = n.click_action || "/";
  const tag = payload?.data?.todoId ? `todo-reminder-${payload.data.todoId}` : "organizer-push";
  self.registration.showNotification(title, {
    body,
    icon,
    requireInteraction: true,
    tag,
    data: { clickAction }
  });
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const targetUrl = event.notification?.data?.clickAction || "/";
  event.waitUntil(
    clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
      return null;
    })
  );
});

