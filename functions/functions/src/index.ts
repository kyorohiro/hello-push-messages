import admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import serviceAccountJson from "../../hello-push-messages-firebase-adminsdk-fbsvc-4f52542438.json" with { type: "json" };
import { FieldValue, Timestamp } from "firebase-admin/firestore";


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
const WORKER_ID =
    process.env.K_REVISION ?? `local-${Math.random().toString(16).slice(2)}`;

const CONCURRENCY_NUM = 10;

admin.initializeApp({
    credential: admin.credential.cert(serviceAccountJson as any),
});

const db = admin.firestore();
const fcm = admin.messaging();




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

async function expandTasksToMsgItemsByTask(
    tasks: { id: string; data: any }[],
    concurrency: number
): Promise<Map<string, MsgItem[]>> {
    const conc = Math.max(1, Math.floor(concurrency || 1));
    const byTask = new Map<string, MsgItem[]>();

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
                await finalize(t.id, "done", { resultSummary: "no-tokens" });
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
                await finalize(t.id, "done", { resultSummary: "no-valid-tokens" });
                continue;
            }

            byTask.set(t.id, items);
        }
    });

    await Promise.all(workers);
    return byTask;
}


// async function expandTasksToMsgItemsAndFinalizeNoToken(
//   tasks: { id: string; data: any }[],
//   concurrency: number
// ): Promise<MsgItem[]> {
//   const conc = Math.max(1, Math.floor(concurrency || 1));
//   const results: MsgItem[] = [];
// 
//   // 共有カーソルでタスクを分配（JSは単一スレッドなのでこの形でOK）
//   let cursor = 0;
// 
//   const workers = Array.from({ length: Math.min(conc, tasks.length) }, async () => {
//     while (true) {
//       const idx = cursor++;
//       if (idx >= tasks.length) return;
// 
//       const t = tasks[idx];
// 
//       const userId: string = t.data.userId;
//       const title: string = t.data.title ?? "";
//       const body: string = t.data.body ?? t.data.message ?? "";
// 
//       const tokensSnap = await db
//         .collection("user")
//         .doc(userId)
//         .collection("push_tokens")
//         .get();
// 
//       if (tokensSnap.empty) {
//         await finalize(t.id, "done", { resultSummary: "no-tokens" });
//         continue;
//       }
// 
//       const localItems: MsgItem[] = [];
//       tokensSnap.forEach((d) => {
//         const token = (d.data() as any).token;
//         if (typeof token === "string" && token.length > 0) {
//           localItems.push({
//             taskId: t.id,
//             userId,
//             tokenId: d.id,
//             token,
//             title,
//             body,
//           });
//         }
//       });
// 
//       if (localItems.length === 0) {
//         await finalize(t.id, "done", { resultSummary: "no-valid-tokens" });
//         continue;
//       }
// 
//       // 共有配列へまとめて追加（順序は保証しない）
//       results.push(...localItems);
//     }
//   });
// 
//   await Promise.all(workers);
//   return results;
// }

// async function expandTasksToMsgItemsAndFinalizeNoToken(
//   tasks: { id: string; data: any }[]
// ): Promise<MsgItem[]> {
//   const msgItems: MsgItem[] = [];
// 
//   // token 展開（シンプル優先で直列）
//   for (const t of tasks) {
//     const userId: string = t.data.userId;
//     const title: string = t.data.title ?? "";
//     const body: string = t.data.message ?? "";
// 
//     const tokensSnap = await db
//       .collection("user")
//       .doc(userId)
//       .collection("push_tokens")
//       .get();
// 
//     if (tokensSnap.empty) {
//       await finalize(t.id, "done", { resultSummary: "no-tokens" });
//       continue;
//     }
// 
//     let anyToken = false;
// 
//     tokensSnap.forEach((d) => {
//       const token = (d.data() as any).token;
//       if (typeof token === "string" && token.length > 0) {
//         anyToken = true;
//         msgItems.push({
//           taskId: t.id,
//           userId,
//           tokenId: d.id,
//           token,
//           title,
//           body,
//         });
//       }
//     });
// 
//     if (!anyToken) {
//       await finalize(t.id, "done", { resultSummary: "no-valid-tokens" });
//     }
//   }
// 
//   return msgItems;
// }

// --------------------
// Main (sendEach)
// --------------------
async function processLeasedTasksWithSendEach(tasks: { id: string; data: any }[]) {
    const byTask = await expandTasksToMsgItemsByTask(tasks, CONCURRENCY_NUM);
    if (byTask.size === 0) return;

    logger.info(`pushWorker: expanded tasks=${byTask.size}`);

    for (const items of byTask.values()) {
        const taskId = items[0].taskId; 
        try {
            let total = 0, success = 0, fail = 0, invalid = 0;
            let lastError: string | null = null;

            for (let i = 0; i < items.length; i += 500) {
                const batch = items.slice(i, i + 500);

                const messages: admin.messaging.Message[] = batch.map((m) => ({
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

                await deleteInvalidTokens(batch, resp.responses, undefined);
            }

            const resultSummary = fail === 0 ? "success" : success > 0 ? "partial" : "failed";
            await finalize(taskId, resultSummary === "failed" ? "failed" : "done", {
                totalTokens: total,
                successCount: success,
                invalidTokenCount: invalid,
                failCount: fail,
                lastError,
                resultSummary,
            });
        } catch (e: any) {
            // 例外でも lease を返して次回に回せるようにする
            await finalize(taskId, "failed", {
                resultSummary: "exception",
                lastError: String(e?.message ?? e).slice(0, 200),
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
