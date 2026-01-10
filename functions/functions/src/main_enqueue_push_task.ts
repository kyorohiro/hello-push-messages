import { admin } from "./firebase.js";
import { SHARD_COUNT } from "./app.js";


const db = admin.firestore();

type PushTaskStatus = "queued" | "done" | "failed";

function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function shardFromUserId(userId: string, shardCount: number): number {
  if (!Number.isFinite(shardCount) || shardCount <= 1) return 0;
  return fnv1a32(userId) % shardCount;
}

async function main() {
  const userId = process.argv[2];
  const title = process.argv[3] ?? "";
  const message = process.argv[4] ?? "";
  const scheduledAtArg = process.argv[5]; // optional

  if (!userId || !title || !message) {
    console.error(
      'Usage: npx tsx src/main_enqueue_push_task.ts <uid> "<title>" "<message>" [scheduledAt]'
    );
    console.error('  scheduledAt: optional, ISO string ("2026-01-11T23:10:00+09:00") or epoch ms');
    process.exit(1);
  }

  let scheduledAt = admin.firestore.Timestamp.now();
  if (scheduledAtArg) {
    const asNum = Number(scheduledAtArg);
    if (Number.isFinite(asNum)) {
      scheduledAt = admin.firestore.Timestamp.fromMillis(asNum);
    } else {
      const d = new Date(scheduledAtArg);
      if (Number.isNaN(d.getTime())) {
        throw new Error("Invalid scheduledAt. Use ISO string or epoch ms.");
      }
      scheduledAt = admin.firestore.Timestamp.fromMillis(d.getTime());
    }
  }

  const shard = shardFromUserId(userId, SHARD_COUNT);

  const ref = db.collection("push_tasks").doc();
  const doc = {
    status: "queued" as PushTaskStatus,
    scheduledAt,
    userId,
    shard, // ✅ A案で追加
    title,
    message,

    leaseUntil: null,
    leaseBy: null,
    attempt: 0,

    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  await ref.set(doc);

  console.log(
    JSON.stringify(
      {
        ok: true,
        taskId: ref.id,
        userId,
        shard,
        title,
        message,
        scheduledAt: scheduledAt.toDate().toISOString(),
        shardCount: SHARD_COUNT,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
