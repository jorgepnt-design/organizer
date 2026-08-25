const { onSchedule } = require("firebase-functions/v2/scheduler");
const { logger } = require("firebase-functions");
const admin = require("firebase-admin");
const { DateTime } = require("luxon");

admin.initializeApp();
const db = admin.firestore();

const TZ = "Europe/Berlin";
const DELIVERY_GRACE_HOURS = 24;
const WEBPUSH_TTL_SECONDS = 86400;
const DEFAULT_SETTINGS = { enabled: true };

function normalizeDueTime(raw) {
  const v = (raw || "").trim();
  if (!v) return "";

  let m = v.match(/^(\d{1,2})[:.](\d{1,2})$/);
  if (m) {
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return "";
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  m = v.match(/^(\d{3,4})$/);
  if (m) {
    const num = m[1];
    const h = Number(num.slice(0, num.length - 2));
    const min = Number(num.slice(-2));
    if (h < 0 || h > 23 || min < 0 || min > 59) return "";
    return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
  }

  m = v.match(/^(\d{1,2})$/);
  if (m) {
    const h = Number(m[1]);
    if (h < 0 || h > 23) return "";
    return `${String(h).padStart(2, "0")}:00`;
  }
  return "";
}

function parseReminderAt(reminderAt) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(reminderAt || "")) return null;
  const dt = DateTime.fromISO(reminderAt, { zone: TZ });
  return dt.isValid ? dt : null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function listAllAuthUsers() {
  const users = [];
  let pageToken = undefined;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    users.push(...page.users);
    pageToken = page.pageToken;
  } while (pageToken);
  return users;
}

async function getUserNotificationSettings(uid) {
  const snap = await db.doc(`users/${uid}/settings/notifications`).get();
  if (!snap.exists) return { ...DEFAULT_SETTINGS };
  const data = snap.data() || {};
  return {
    enabled: typeof data.enabled === "boolean" ? data.enabled : DEFAULT_SETTINGS.enabled,
  };
}

async function getUserPushTokens(uid) {
  const snap = await db.collection(`users/${uid}/pushTokens`).get();
  return snap.docs
    .map((d) => ({ id: d.id, token: d.get("token") || "" }))
    .filter((t) => t.token);
}

async function markNotificationSent(uid, dedupeKey, payload) {
  const ref = db.doc(`users/${uid}/notificationSent/${dedupeKey}`);
  const existing = await ref.get();
  if (existing.exists) return false;
  const expireAt = admin.firestore.Timestamp.fromDate(
    DateTime.now().plus({ days: 30 }).toJSDate()
  );
  await ref.set({
    ...payload,
    sentAt: admin.firestore.FieldValue.serverTimestamp(),
    expireAt,
  });
  return true;
}

async function removeInvalidTokens(uid, invalidTokenDocIds) {
  if (!invalidTokenDocIds.length) return;
  const batch = db.batch();
  for (const id of invalidTokenDocIds) {
    batch.delete(db.doc(`users/${uid}/pushTokens/${id}`));
  }
  await batch.commit();
}

async function processUser(uid, now) {
  const settings = await getUserNotificationSettings(uid);
  if (!settings.enabled) return { sent: 0, skipped: "disabled" };

  const tokenDocs = await getUserPushTokens(uid);
  if (!tokenDocs.length) return { sent: 0, skipped: "no_tokens" };

  const foldersSnap = await db.collection(`users/${uid}/todoOrdner`).get();
  if (foldersSnap.empty) return { sent: 0, skipped: "no_folders" };

  let sentCount = 0;
  const invalidTokenDocIds = new Set();

  for (const folderDoc of foldersSnap.docs) {
    const folderId = folderDoc.id;
    const folderName = folderDoc.get("name") || "Ordner";
    const todosSnap = await db.collection(`users/${uid}/todoOrdner/${folderId}/todos`).get();

    for (const todoDoc of todosSnap.docs) {
      const todo = todoDoc.data() || {};
      if (todo.status === "erledigt") continue;
      if (!todo.reminderAt) continue;

      const triggerAt = parseReminderAt(todo.reminderAt);
      if (!triggerAt) continue;

      const latestAt = triggerAt.plus({ hours: DELIVERY_GRACE_HOURS });
      if (now < triggerAt || now > latestAt) continue;

      const reminderDate = todo.reminderAt.slice(0, 10);
      const reminderTime = normalizeDueTime(todo.reminderAt.slice(11));
      const dueTime = normalizeDueTime(todo.faelligZeit || "");
      const dueLabel = todo.faellig
        ? DateTime.fromISO(todo.faellig, { zone: TZ }).toFormat("dd.MM.yyyy") + (dueTime ? ` ${dueTime}` : "")
        : "";
      const reminderLabel = triggerAt.toFormat("dd.MM.yyyy HH:mm");
      const dedupeKey = encodeURIComponent(`${folderId}|${todoDoc.id}|${todo.reminderAt}`);
      const canSend = await markNotificationSent(uid, dedupeKey, {
        folderId,
        folderName,
        todoId: todoDoc.id,
        title: todo.text || "Aufgabe",
        reminderAt: todo.reminderAt,
      });
      if (!canSend) continue;

      const notification = {
        title: "Jorge Organizer: Erinnerung",
        body: dueLabel
          ? `${todo.text || "Aufgabe"} (${folderName}) - Erinnerung ${reminderLabel} - Faellig ${dueLabel}`
          : `${todo.text || "Aufgabe"} (${folderName}) - Erinnerung ${reminderLabel}`,
      };

      const tokenValues = tokenDocs.map((t) => t.token);
      const tokenChunks = chunk(tokenValues, 500);
      for (const tokens of tokenChunks) {
        const result = await admin.messaging().sendEachForMulticast({
          tokens,
          notification,
          data: {
            type: "todo_reminder",
            folderId,
            todoId: todoDoc.id,
            dueDate: todo.faellig || "",
            dueTime: dueTime || "",
            reminderAt: todo.reminderAt || "",
            reminderDate,
            reminderTime: reminderTime || "",
          },
          webpush: {
            fcmOptions: { link: "/organizer.html" },
            headers: {
              TTL: String(WEBPUSH_TTL_SECONDS),
              Urgency: "high",
            },
            notification: {
              icon: "/organizer-icon.svg",
              requireInteraction: true,
              tag: `todo-reminder-${todoDoc.id}`,
            },
          },
        });

        result.responses.forEach((resp, idx) => {
          if (resp.success) return;
          const code = resp.error?.code || "";
          if (
            code === "messaging/registration-token-not-registered" ||
            code === "messaging/invalid-registration-token"
          ) {
            const badToken = tokens[idx];
            const tokenDoc = tokenDocs.find((t) => t.token === badToken);
            if (tokenDoc) invalidTokenDocIds.add(tokenDoc.id);
          }
        });
      }

      sentCount++;
    }
  }

  await removeInvalidTokens(uid, [...invalidTokenDocIds]);
  return { sent: sentCount, invalidTokensRemoved: invalidTokenDocIds.size };
}

exports.sendDueTodoPushNotifications = onSchedule(
  {
    schedule: "*/5 * * * *",
    timeZone: TZ,
    region: "europe-west3",
    memory: "512MiB",
    timeoutSeconds: 540,
  },
  async () => {
    const now = DateTime.now().setZone(TZ);
    const users = await listAllAuthUsers();
    logger.info("Push scheduler started", { users: users.length, now: now.toISO() });

    let totalSent = 0;
    for (const user of users) {
      try {
        const result = await processUser(user.uid, now);
        totalSent += result.sent || 0;
      } catch (err) {
        logger.error("Failed processing user push reminders", { uid: user.uid, error: String(err) });
      }
    }

    logger.info("Push scheduler finished", { totalSent });
  }
);
