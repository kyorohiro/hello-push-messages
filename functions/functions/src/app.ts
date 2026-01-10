import { logger } from "firebase-functions";
import { admin, db, fcm, WORKER_ID } from "./firebase.js";

type MsgItem = {
    taskId: string;
    userId: string;
    tokenId: string;
    token: string;
    title: string;
    body: string;
};

type TaskStatus = "queued" | "done" | "failed";

const REGION = "asia-northeast1";
const TIME_ZONE = "Asia/Tokyo";

const TASK_LIMIT = 200;
const LEASE_MS = 2 * 60 * 1000; // 2分: 落ちても自動復帰

const CONCURRENCY_NUM = 10;
const COMMIT_NUM = 100; // MAX 500
const BATCH_NUM = 100;// MAX 500
const SHARD_COUNT = 1; // shardId = [0,]



const DELETE_CONCURRENCY = 30;

const INVALID = new Set([
    "messaging/registration-token-not-registered",
    "messaging/invalid-registration-token",
]);




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
            await ref.delete().catch(() => { });
        }
    });

    await Promise.all(workers);
    return refs.length;
}


const action = async (shardId: number | undefined) => {
    const now = admin.firestore.Timestamp.now();

    let q: FirebaseFirestore.Query = db
        .collection("push_tasks")
        .where("status", "==", "queued")
        .where("scheduledAt", "<=", now);

    if (shardId !== undefined) {
        q = q.where("shardId", "==", shardId);
    }

    const tasksSnap = await q
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
/*
export const pushWorker = onSchedule(
    {
        region: REGION,
        schedule: "every 30 minutes",
        timeZone: TIME_ZONE,
        timeoutSeconds: 540, // 9分
        memory: "1GiB",
    },
      async () => {
    // all-run lock（schedule 同士や kick と衝突しても二重にならない）
    const locked = await tryAcquireRunLock(undefined);
    if (!locked) {
      logger.info("pushWorker30m: skipped (run-lock busy)");
      return;
    }

    try {
      const start = Timestamp.now();

      // shard を順番に回す（SHARD_COUNT=1なら1回だけ）
      for (let sid = 0; sid < SHARD_COUNT; sid++) {
        // shard個別にも lock したいならここで tryAcquireRunLock(sid) を入れる
        while (0 < (await action(sid) ?? 0)) {
          const now = Timestamp.now();
          if ((now.toMillis() - start.toMillis()) / 1000 > 480) break; // 8分で打ち切り等
        }
      }
    } finally {
      await releaseRunLock(undefined);
    }
  }
);
*/

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

async function expandTasksToMsgItemsByTask(
    tasks: { id: string; data: any }[],
    concurrency: number
): Promise<{ byTask: Map<string, MsgItem[]>; pendingFinalizes: Map<string, any> }> {
    const conc = Math.max(1, Math.floor(concurrency || 1));
    const byTask = new Map<string, MsgItem[]>();
    const pendingFinalizes = new Map<string, any>();

    let cursor = 0;
    const workers = Array.from({ length: Math.min(conc, tasks.length) }, async () => {
        while (true) {
            const idx = cursor++;
            if (idx >= tasks.length) return;

            const t = tasks[idx];
            const userId: string = t.data.userId;
            const title: string = t.data.title ?? "";
            const body: string = t.data.body ?? t.data.message ?? "";

            const tokensSnap = await db.collection("user").doc(userId).collection("push_tokens").get();

            if (tokensSnap.empty) {
                // await finalize(t.id, "done", { resultSummary: "no-tokens" });
                pendingFinalizes.set(t.id, buildFinalizeData("done", { resultSummary: "no-tokens" }));
                continue;
            }

            const items: MsgItem[] = [];
            tokensSnap.forEach((d) => {
                const token = (d.data() as any).token;
                if (typeof token === "string" && token.length > 0) {
                    items.push({ taskId: t.id, userId, tokenId: d.id, token, title, body });
                }
            });

            if (items.length === 0) {
                //await finalize(t.id, "done", { resultSummary: "no-valid-tokens" });
                pendingFinalizes.set(t.id, buildFinalizeData("done", { resultSummary: "no-valid-tokens" }));
                continue;
            }

            byTask.set(t.id, items);
        }
    });

    await Promise.all(workers);
    //return byTask;
    return { byTask, pendingFinalizes };
}

// --------------------
// Main (sendEach)
// --------------------
async function processLeasedTasksWithSendEach(tasks: { id: string; data: any }[]) {
    const { byTask, pendingFinalizes } = await expandTasksToMsgItemsByTask(tasks, CONCURRENCY_NUM);

    // finalize を溜める（taskId -> update data）
    //const pendingFinalizes = new Map<string, any>();

    for (const items of byTask.values()) {
        const taskId = items[0].taskId;

        try {
            let total = 0, success = 0, fail = 0, invalid = 0;
            let lastError: string | null = null;

            for (let i = 0; i < items.length; i += BATCH_NUM) {
                const batchItems = items.slice(i, i + BATCH_NUM);

                const messages: admin.messaging.Message[] = batchItems.map((m) => ({
                    token: m.token,
                    notification: { title: m.title, body: m.body },
                    data: { taskId: m.taskId, userId: m.userId },
                }));

                const resp = await fcm.sendEach(messages);

                resp.responses.forEach((r) => {
                    total++;
                    if (r.success) success++;
                    else {
                        fail++;
                        const code = (r.error as any)?.code ?? "";
                        lastError = `${code}`.slice(0, 200);
                        if (INVALID.has(code)) invalid++;
                    }
                });

                await deleteInvalidTokens(batchItems, resp.responses, undefined);
            }

            const resultSummary = fail === 0 ? "success" : success > 0 ? "partial" : "failed";
            const status: TaskStatus = resultSummary === "failed" ? "failed" : "done";

            pendingFinalizes.set(taskId, buildFinalizeData(status, {
                totalTokens: total,
                successCount: success,
                invalidTokenCount: invalid,
                failCount: fail,
                lastError,
                resultSummary,
            }));
        } catch (e: any) {
            pendingFinalizes.set(taskId, buildFinalizeData("failed", {
                resultSummary: "exception",
                lastError: String(e?.message ?? e).slice(0, 200),
            }));
        }
    }

    // ✅ まとめて更新
    await commitFinalizes(pendingFinalizes);
}


function buildFinalizeData(status: TaskStatus, extra: Record<string, any>) {
    return {
        status,
        doneAt: admin.firestore.FieldValue.serverTimestamp(),
        leaseUntil: null,
        leaseBy: null,
        ...extra,
    };
}

async function commitFinalizes(pending: Map<string, any>) {
    if (pending.size === 0) return;

    // 500制限があるので分割コミット
    const entries = [...pending.entries()];
    for (let i = 0; i < entries.length; i += COMMIT_NUM) { // 余裕をみて450
        const chunk = entries.slice(i, i + COMMIT_NUM);
        const batch = db.batch();
        for (const [taskId, data] of chunk) {
            batch.update(db.collection("push_tasks").doc(taskId), data);
        }
        await batch.commit();
    }
}


export {
    action, SHARD_COUNT
}

