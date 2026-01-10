import admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import serviceAccountJson from "../../hello-push-messages-firebase-adminsdk-fbsvc-4f52542438.json" with { type: "json" };
import { FieldValue, Timestamp } from "firebase-admin/firestore";

admin.initializeApp({
    credential: admin.credential.cert(serviceAccountJson as any),
});

const db = admin.firestore();
const fcm = admin.messaging();

type TaskStatus = "queued" | "done" | "failed";

const REGION = "asia-northeast1";
const TIME_ZONE = "Asia/Tokyo";

const TASK_LIMIT = 200;
const LEASE_MS = 2 * 60 * 1000; // 2分: 落ちても自動復帰
const WORKER_ID =
    process.env.K_REVISION ?? `local-${Math.random().toString(16).slice(2)}`;


const DELETE_CONCURRENCY = 30;

const INVALID = new Set([
  "messaging/registration-token-not-registered",
  "messaging/invalid-registration-token",
]);


type MsgItem = {
    taskId: string;
    userId: string;
    tokenId: string;
    token: string;
    title: string;
    body: string;
};


function isInvalidTokenCode(code: string) {
  return INVALID.has(code);
}

function tokenRefOf(item: MsgItem) {
  return db.collection("user").doc(item.userId).collection("push_tokens").doc(item.tokenId);
}

async function deleteInvalidTokens(
  batch: MsgItem[],
  responses: { success: boolean; error?: any }[],
  deadlineMs?: number
) {
  // 重複deleteを避ける（同じ token doc が複数回出ても1回だけ）
  const uniq = new Map<string, admin.firestore.DocumentReference>();

  for (let i = 0; i < responses.length; i++) {
    const r = responses[i];
    if (r.success) continue;

    const code = r.error?.code ?? "";
    if (!isInvalidTokenCode(code)) continue;

    const item = batch[i];
    const key = `${item.userId}/${item.tokenId}`;
    if (!uniq.has(key)) {
      uniq.set(key, tokenRefOf(item));
    }
  }

  const refs = [...uniq.values()];
  if (refs.length === 0) return 0;

  // 上限付き並列
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, DELETE_CONCURRENCY) }, async () => {
    while (cursor < refs.length) {
      if (deadlineMs && Date.now() >= deadlineMs) return;
      const ref = refs[cursor++];
      await ref.delete().catch(() => {});
    }
  });

  await Promise.all(workers);
  return refs.length;
}


export const action = async () => {
    const now = admin.firestore.Timestamp.now();

    // queued のうち「leaseなし or lease切れ」を拾う
    const tasksSnap = await db
        .collection("push_tasks")
        .where("status", "==", "queued")
        .where("scheduledAt", "<=", now)
        .orderBy("scheduledAt", "asc")
        .limit(TASK_LIMIT)
        .get();

    if (tasksSnap.empty) {
        logger.info("pushWorker: no queued tasks");
        return;
    }

    // lease を取れた task だけ処理
    const leased: { id: string; data: any }[] = [];
    for (const doc of tasksSnap.docs) {
        const got = await leaseTask(doc.id);
        if (got) leased.push({ id: doc.id, data: doc.data() });
    }

    if (leased.length === 0) {
        logger.info("pushWorker: nothing leased");
        return;
    }

    logger.info(`pushWorker: leased ${leased.length} tasks`);

    await processLeasedTasksWithSendEach(leased);
    return leased.length;
};

export const pushWorker = onSchedule(
    {
        region: REGION,
        schedule: "every 5 minutes",
        timeZone: TIME_ZONE,
        timeoutSeconds: 540,
        memory: "1GiB",
    },
    async () => {
        const start = Timestamp.now();
        while (0 < (await action() ?? 0)) {
            const now = Timestamp.now();
            if ((now.toMillis() - start.toMillis()) / 1000 > 300) {
                break;
            }
        }
    }
);

// --------------------
// Lease（期限付きロック）
// --------------------
async function leaseTask(taskId: string): Promise<boolean> {
    const ref = db.collection("push_tasks").doc(taskId);
    const leaseUntil = admin.firestore.Timestamp.fromMillis(Date.now() + LEASE_MS);

    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return false;

        const d = snap.data() as any;
        if (d.status !== "queued") return false;

        const lu = d.leaseUntil as admin.firestore.Timestamp | undefined;
        const expired = !lu || lu.toMillis() <= Date.now();
        if (!expired) return false;

        tx.update(ref, {
            leaseUntil,
            leaseBy: WORKER_ID,
            leasedAt: admin.firestore.FieldValue.serverTimestamp(),
            attempt: admin.firestore.FieldValue.increment(1),
        });

        return true;
    });
}

async function expandTasksToMsgItemsAndFinalizeNoToken(
  tasks: { id: string; data: any }[]
): Promise<MsgItem[]> {
  const msgItems: MsgItem[] = [];

  // token 展開（シンプル優先で直列）
  for (const t of tasks) {
    const userId: string = t.data.userId;
    const title: string = t.data.title ?? "";
    const body: string = t.data.message ?? "";

    const tokensSnap = await db
      .collection("user")
      .doc(userId)
      .collection("push_tokens")
      .get();

    if (tokensSnap.empty) {
      await finalize(t.id, "done", { resultSummary: "no-tokens" });
      continue;
    }

    let anyToken = false;

    tokensSnap.forEach((d) => {
      const token = (d.data() as any).token;
      if (typeof token === "string" && token.length > 0) {
        anyToken = true;
        msgItems.push({
          taskId: t.id,
          userId,
          tokenId: d.id,
          token,
          title,
          body,
        });
      }
    });

    if (!anyToken) {
      await finalize(t.id, "done", { resultSummary: "no-valid-tokens" });
    }
  }

  return msgItems;
}

// --------------------
// Main (sendEach)
// --------------------
async function processLeasedTasksWithSendEach(tasks: { id: string; data: any }[]) {

    const msgItems = await expandTasksToMsgItemsAndFinalizeNoToken(tasks);

    if (msgItems.length === 0) return;

    logger.info(`pushWorker: expanded to ${msgItems.length} messages`);

    // 500件ずつ sendEach
    for (let i = 0; i < msgItems.length; i += 500) {
        const batch = msgItems.slice(i, i + 500);

        const messages: admin.messaging.Message[] = batch.map((m) => ({
            token: m.token,
            notification: { title: m.title, body: m.body },
            data: { taskId: m.taskId, userId: m.userId },
        }));

        const resp = await fcm.sendEach(messages);

        const perTask = new Map<
            string,
            { total: number; success: number; fail: number; invalid: number; lastError?: string }
        >();

        const bump = (taskId: string, f: (x: any) => void) => {
            const cur = perTask.get(taskId) ?? { total: 0, success: 0, fail: 0, invalid: 0 };
            f(cur);
            perTask.set(taskId, cur);
        };

        resp.responses.forEach((r, idx) => {
            const item = batch[idx];
            bump(item.taskId, (s) => {
                s.total++;
                if (r.success) {
                    s.success++;
                } else {
                    s.fail++;
                    const code = (r.error as any)?.code ?? "";
                    s.lastError = `${code}`.slice(0, 200);
                    if (INVALID.has(code)) s.invalid++;
                }
            });
        });

        await deleteInvalidTokens(batch, resp.responses, /* deadlineMs? */ undefined);
        //
        // 無効token掃除（シンプルに直列）
        //
        //for (let idx = 0; idx < resp.responses.length; idx++) {
        //    const r = resp.responses[idx];
        //    if (!r.success) {
        //        const code = (r.error as any)?.code ?? "";
        //        if (INVALID.has(code)) {
        //            const item = batch[idx];
        //            await db
        //                .collection("user")
        //                .doc(item.userId)
        //                .collection("push_tokens")
        //                .doc(item.tokenId)
        //                .delete()
        //                .catch(() => { });
        //        }
        //    }
        //}

        // task更新（このチャンク分の集計なので、task跨ぎが気になるなら task単位に寄せる必要あり）
        for (const [taskId, s] of perTask.entries()) {
            const resultSummary = s.fail === 0 ? "success" : s.success > 0 ? "partial" : "failed";
            await finalize(taskId, resultSummary === "failed" ? "failed" : "done", {
                totalTokens: s.total,
                successCount: s.success,
                invalidTokenCount: s.invalid,
                failCount: s.fail,
                lastError: s.lastError ?? null,
                resultSummary,
            });
        }
    }
}

async function finalize(taskId: string, status: TaskStatus, extra: Record<string, any>) {
    await db.collection("push_tasks").doc(taskId).update({
        status,
        doneAt: admin.firestore.FieldValue.serverTimestamp(),
        leaseUntil: null, // ✅ 返却
        leaseBy: null,
        ...extra,
    });
}
