import admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import serviceAccountJson from '../../hello-push-messages-firebase-adminsdk-fbsvc-4f52542438.json' with { type: 'json' };

console.log(serviceAccountJson)
admin.initializeApp({
    credential: admin.credential.cert(serviceAccountJson as any),
});
const db = admin.firestore();
const fcm = admin.messaging();

type TaskStatus = "queued" | "processing" | "done" | "failed";

const REGION = "asia-northeast1";


export const action = async () => {
    const now = admin.firestore.Timestamp.now();

    // 1回で取りすぎない（まずは200 taskくらい）
    const tasksSnap = await db
        .collection("push_tasks")
        .where("status", "==", "queued")
        .where("scheduledAt", "<=", now)
        .orderBy("scheduledAt", "asc")
        .limit(200)
        .get();

    if (tasksSnap.empty) {
        logger.info("pushWorker: no queued tasks");
        return;
    }

    // まずロックを取れるものだけ processing にする（競合対策）
    const locked: { id: string; data: any }[] = [];
    for (const doc of tasksSnap.docs) {
        const ok = await lockTask(doc.id);
        if (ok) locked.push({ id: doc.id, data: doc.data() });
    }

    if (locked.length === 0) {
        logger.info("pushWorker: nothing locked");
        return;
    }

    logger.info(`pushWorker: locked ${locked.length} tasks`);

    // task → tokenごとの message に展開して sendAll(500) で流す
    await processLockedTasksWithSendAll(locked);
};
// 5分ごと（Pub/Sub無しで見た目がシンプル）
export const pushWorker = onSchedule(
    {
        region: REGION,
        schedule: "every 5 minutes",
        timeZone: "Asia/Tokyo",
        timeoutSeconds: 540, // 9分
        memory: "1GiB",
    },
    action
);

async function lockTask(taskId: string): Promise<boolean> {
    const ref = db.collection("push_tasks").doc(taskId);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const data = snap.data() as any;
        if (data.status !== "queued") return false;

        tx.update(ref, {
            status: "processing" as TaskStatus,
            lockedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        return true;
    });
}

async function processLockedTasksWithSendAll(
    tasks: { id: string; data: any }[]
) {
    type MsgItem = {
        taskId: string;
        userId: string;
        tokenId: string;
        token: string;
        title: string;
        body: string;
    };

    const msgItems: MsgItem[] = [];

    // tokens を集める（ここは並列化してOKだが、まずは安全運用で軽め）
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
            await markDone(t.id, { resultSummary: "no-tokens" });
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
            await markDone(t.id, { resultSummary: "no-valid-tokens" });
        }
    }

    if (msgItems.length === 0) return;

    logger.info(`pushWorker: expanded to ${msgItems.length} messages`);

    // 500件ずつ sendAll
    for (let i = 0; i < msgItems.length; i += 500) {
        const batch = msgItems.slice(i, i + 500);

        const messages: admin.messaging.Message[] = batch.map((m) => ({
            token: m.token,
            notification: { title: m.title, body: m.body },
            data: {
                taskId: m.taskId,
                userId: m.userId,
            },
        }));

        const resp = await fcm.sendAll(messages);

        // 結果集計（taskIdごと）
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

                    if (
                        code === "messaging/registration-token-not-registered" ||
                        code === "messaging/invalid-registration-token"
                    ) {
                        s.invalid++;
                    }
                }
            });
        });

        // 無効 token を掃除（まとめて消すのは難しいので雑に順次）
        for (let idx = 0; idx < resp.responses.length; idx++) {
            const r = resp.responses[idx];
            if (!r.success) {
                const code = (r.error as any)?.code ?? "";
                if (
                    code === "messaging/registration-token-not-registered" ||
                    code === "messaging/invalid-registration-token"
                ) {
                    const item = batch[idx];
                    await db
                        .collection("user")
                        .doc(item.userId)
                        .collection("push_tokens")
                        .doc(item.tokenId)
                        .delete()
                        .catch(() => { });
                }
            }
        }

        // task を done/failed に更新
        for (const [taskId, s] of perTask.entries()) {
            const resultSummary =
                s.fail === 0 ? "success" : s.success > 0 ? "partial" : "failed";

            await db.collection("push_tasks").doc(taskId).update({
                status: (resultSummary === "failed" ? "failed" : "done") as TaskStatus,
                doneAt: admin.firestore.FieldValue.serverTimestamp(),
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

async function markDone(taskId: string, extra: Record<string, any>) {
    await db.collection("push_tasks").doc(taskId).update({
        status: "done" as TaskStatus,
        doneAt: admin.firestore.FieldValue.serverTimestamp(),
        ...extra,
    });
}
