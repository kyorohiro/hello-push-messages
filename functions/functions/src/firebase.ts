import admin from "firebase-admin";
import serviceAccountJson from "../../hello-push-messages-firebase-adminsdk-fbsvc-4f52542438.json" with { type: "json" };

admin.initializeApp({
    credential: admin.credential.cert(serviceAccountJson as any),
});

const db = admin.firestore();
const fcm = admin.messaging();

const WORKER_ID =
    process.env.K_REVISION ?? `local-${Math.random().toString(16).slice(2)}`;

export {
    db, fcm, admin, WORKER_ID
}