
import {admin,db, WORKER_ID } from "./firebase.js";

const RUN_LOCK_MS = 2 * 60 * 1000; // 2分ロック（action の想定時間に合わせて調整）

function lockDocId(shardId: number | undefined) {
  const sid = shardId === undefined ? "all" : String(shardId);
  return `pushWorker_${sid}`;
}

async function tryAcquireRunLock(shardId: number | undefined): Promise<boolean> {
  const ref = db.collection("system_locks").doc(lockDocId(shardId));
  const until = admin.firestore.Timestamp.fromMillis(Date.now() + RUN_LOCK_MS);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const d = snap.exists ? (snap.data() as any) : null;

    const cur = d?.leaseUntil as admin.firestore.Timestamp | undefined;
    const expired = !cur || cur.toMillis() <= Date.now();
    if (!expired) return false;

    tx.set(ref, {
      leaseUntil: until,
      leaseBy: WORKER_ID,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    return true;
  });
}

async function releaseRunLock(shardId: number | undefined) {
  const ref = db.collection("system_locks").doc(lockDocId(shardId));
  await ref.set(
    {
      leaseUntil: admin.firestore.Timestamp.fromMillis(0),
      leaseBy: null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  ).catch(() => {});
}

export {
    tryAcquireRunLock, releaseRunLock
}