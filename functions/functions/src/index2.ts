import admin from "firebase-admin";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import serviceAccountJson from '../../hello-push-messages-firebase-adminsdk-fbsvc-4f52542438.json' with { type: 'json' };
import { FieldValue, Timestamp } from "firebase-admin/firestore";


console.log(serviceAccountJson)
admin.initializeApp({
    credential: admin.credential.cert(serviceAccountJson as any),
});

const db = admin.firestore();
const fcm = admin.messaging();

type TaskStatus = "queued" | "processing" | "done" | "failed";

const REGION = "asia-northeast1";
const TIME_ZONE = "Asia/Tokyo";

// shard数（半年後100万/日を見据えて最初から20）
// const SHARDS = 20;

// 1回のクエリで拾う task 数（sendAll(500) と相性が良い）
const TASK_LIMIT = 500;

// token 読み取りの並列数（Firestore負荷と相談）
const TOKEN_FETCH_CONCURRENCY = 30;

// 1回の実行で使う時間（onSchedule timeout=540s なので安全側）
const TIME_BUDGET_MS = Math.floor(8.5 * 60 * 1000); // 8分30秒

// processing のまま放置された task を「死んだ」とみなす時間（復旧用）
const STALE_LOCK_MS = 30 * 60 * 1000; // 30分

// ---------------------------------------------
// public exports（20本分を生成）
// ---------------------------------------------
export const pushWorker = makeWorker(undefined);


export const action = async (shardId: number | undefined) => {
    const startedAt = Date.now();
    const deadline = startedAt + TIME_BUDGET_MS;

    logger.info(`pushWorker shard=${shardId} start`);

    // （任意）processing で死んでるものを queued に戻す（簡易復旧）
    // 大量運用時は別ジョブに分けてもOK
    await recoverStaleTasks(shardId).catch((e) => {
        logger.warn(`recoverStaleTasks shard=${shardId} skipped`, e);
    });

    let rounds = 0;
    let totalLockedTasks = 0;
    let totalExpandedMessages = 0;

    while (Date.now() < deadline) {
        rounds++;

        // queued を scheduledAt順に取る
        const now = Timestamp.now();
        let col: any = db
            .collection("push_tasks");
        if (shardId != undefined) {
            col = col.where("shard", "==", shardId);
        }
        const snap = await col.where("status", "==", "queued")
            .where("scheduledAt", "<=", now)
            .orderBy("scheduledAt", "asc")
            .limit(TASK_LIMIT)
            .get();

        if (snap.empty) {
            logger.info(`pushWorker shard=${shardId} round=${rounds} no queued`);
            break;
        }

        // lock（transactionで queued→processing）
        const locked: { id: string; data: any }[] = [];
        for (const doc of snap.docs) {
            if (Date.now() >= deadline) break;

            const ok = await lockTask(doc.id);
            if (ok) locked.push({ id: doc.id, data: doc.data() });
        }

        if (locked.length === 0) {
            logger.info(`pushWorker shard=${shardId} round=${rounds} nothing locked`);
            break;
        }

        totalLockedTasks += locked.length;

        // tokens を取って tokenごとの message に展開 → sendAll
        const expanded = await processLockedTasksSendAll(locked, deadline);
        totalExpandedMessages += expanded;

        // 時間がまだあれば次の TASK_LIMIT を拾いにいく
    }

    logger.info(
        `pushWorker shard=${shardId} done rounds=${rounds} lockedTasks=${totalLockedTasks} expandedMessages=${totalExpandedMessages} elapsedMs=${Date.now() - startedAt}`
    );
}

function makeWorker(shardId: number | undefined) {
    return onSchedule(
        {
            region: REGION,
            schedule: "every 5 minutes",
            timeZone: TIME_ZONE,
            timeoutSeconds: 540,
            memory: "1GiB",
        },
        () => action(shardId))
}
// ---------------------------------------------
// Lock / Recover
// ---------------------------------------------
async function lockTask(taskId: string): Promise<boolean> {
    const ref = db.collection("push_tasks").doc(taskId);

    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return false;
        const data = snap.data() as any;
        if (data.status !== "queued") return false;

        tx.update(ref, {
            status: "processing" as TaskStatus,
            lockedAt: FieldValue.serverTimestamp(),
        });
        return true;
    });
}

async function recoverStaleTasks(shardId: number | undefined) {
    const cutoff = Timestamp.fromMillis(Date.now() - STALE_LOCK_MS);

    // lockedAt が古い processing を queued に戻す（簡易）
    // ※ lockedAt が無い古いデータは対象外
    let col: any = db
        .collection("push_tasks")
    if (shardId != undefined) {
        col = col.where("shard", "==", shardId)
    }
    const snap = await col.where("status", "==", "processing")
        .where("lockedAt", "<=", cutoff).limit(200).get();

    if (snap.empty) return;

    const batch = db.batch();
    snap.docs.forEach((d: any) => {
        batch.update(d.ref, {
            status: "queued" as TaskStatus,
            recoveredAt: FieldValue.serverTimestamp(),
        });
    });
    await batch.commit();

    logger.info(`recoverStaleTasks shard=${shardId} recovered=${snap.size}`);
}

// ---------------------------------------------
// Main processing (sendAll)
// ---------------------------------------------
async function processLockedTasksSendAll(
    tasks: { id: string; data: any }[],
    deadline: number
): Promise<number> {
    type MsgItem = {
        taskId: string;
        userId: string;
        tokenId: string;
        token: string;
        title: string;
        body: string;
    };

    type Stat = { total: number; success: number; fail: number; invalid: number; lastError?: string };

    const msgItems: MsgItem[] = [];

    // token 読み取り：上限付き並列（cursorは共有なので厳密には競合するけど、JSは単一スレッドなので実用上OK）
    let cursor = 0;
    const workers = Array.from({ length: TOKEN_FETCH_CONCURRENCY }, async () => {
        while (cursor < tasks.length && Date.now() < deadline) {
            const t = tasks[cursor++];
            const taskId = t.id;

            const userId: string = t.data.userId;
            const title: string = t.data.title ?? "";
            const body: string = t.data.message ?? "";

            const tokensSnap = await db.collection("user").doc(userId).collection("push_tokens").get();

            if (tokensSnap.empty) {
                await markDone(taskId, { resultSummary: "no-tokens" });
                continue;
            }

            let anyToken = false;
            tokensSnap.forEach((d) => {
                const token = (d.data() as any).token;
                if (typeof token === "string" && token.length > 0) {
                    anyToken = true;
                    msgItems.push({
                        taskId,
                        userId,
                        tokenId: d.id,
                        token,
                        title,
                        body,
                    });
                }
            });

            if (!anyToken) {
                await markDone(taskId, { resultSummary: "no-valid-tokens" });
            }
        }
    });

    await Promise.all(workers);

    if (msgItems.length === 0) return 0;
    logger.info(`expanded messages=${msgItems.length}`);

    // ✅ チャンクを跨いでも task 集計が壊れないように “全体で累積”
    const perTaskGlobal = new Map<string, Stat>();

    const bump = (taskId: string, f: (s: Stat) => void) => {
        const cur = perTaskGlobal.get(taskId) ?? { total: 0, success: 0, fail: 0, invalid: 0 };
        f(cur);
        perTaskGlobal.set(taskId, cur);
    };

    // 無効 token 削除は直列にすると遅いので、上限つき並列で実行
    const INVALID_CODES = new Set([
        "messaging/registration-token-not-registered",
        "messaging/invalid-registration-token",
    ]);

    const deleteQueue: Array<() => Promise<void>> = [];
    const runWithConcurrency = async (jobs: Array<() => Promise<void>>, limit: number) => {
        const q = jobs.slice(); // ローカルキュー
        const runners = Array.from({ length: Math.max(1, limit) }, async () => {
            while (q.length && Date.now() < deadline) {
                const job = q.pop()!;     // pop は atomic に近い（単一スレッド）
                await job().catch(() => { });
            }
        });
        await Promise.all(runners);
    };

    // 500メッセージずつ送信
    for (let i = 0; i < msgItems.length && Date.now() < deadline; i += 500) {
        const batchItems = msgItems.slice(i, i + 500);

        const messages = batchItems.map((m) => ({
            token: m.token,
            notification: { title: m.title, body: m.body },
            data: { taskId: m.taskId, userId: m.userId },
        }));

        let resp:
            | Awaited<ReturnType<typeof fcm.sendEach>>
            | null = null;

        try {
            resp = await fcm.sendEach(messages);
        } catch (e: any) {
            // ✅ sendEach 自体が落ちた場合、このチャンクの task を “まとめて failed” にしてロック滞留を減らす
            const err = (e?.message ?? String(e)).slice(0, 200);
            const counts = new Map<string, number>();
            for (const x of batchItems) counts.set(x.taskId, (counts.get(x.taskId) ?? 0) + 1);

            for (const [taskId, n] of counts) {
                bump(taskId, (s) => {
                    s.total += n;
                    s.fail += n;
                    s.lastError = err;
                });
            }

            logger.error("fcm.sendEach threw", e);
            continue; // 次のチャンクへ（時間内なら）
        }

        resp.responses.forEach((r, idx) => {
            const item = batchItems[idx];

            bump(item.taskId, (s) => {
                s.total++;
                if (r.success) {
                    s.success++;
                } else {
                    s.fail++;
                    const code = (r.error as any)?.code ?? "";
                    s.lastError = `${code}`.slice(0, 200);

                    if (INVALID_CODES.has(code)) {
                        s.invalid++;
                        // ✅ 無効token削除はキューに積んで後でまとめて実行
                        deleteQueue.push(async () => {
                            await db
                                .collection("user")
                                .doc(item.userId)
                                .collection("push_tokens")
                                .doc(item.tokenId)
                                .delete();
                            return;
                        }
                        );
                    }
                }
            });
        });
    }

    // ✅ 無効token削除をまとめて実行（Firestore負荷と相談で 20〜50 くらい）
    await runWithConcurrency(deleteQueue, 30);

    // ✅ 最後に task 単位で1回だけ update（500跨ぎでも正しい）
    // ただし markDone 済み(no-tokens等) の task が混ざる可能性があるので update が失敗しても落とさない
    const updateJobs: Array<() => Promise<void>> = [];
    for (const [taskId, s] of perTaskGlobal.entries()) {
        updateJobs.push(async () => {
            const ref = db.collection("push_tasks").doc(taskId);
            const resultSummary = s.fail === 0 ? "success" : s.success > 0 ? "partial" : "failed";

            await db.runTransaction(async (tx) => {
                const snap = await tx.get(ref);
                if (!snap.exists) return;

                const cur = snap.data() as any;
                if (cur?.finalized === true) return; // ✅ markDone 済みは触らない

                tx.update(ref, {
                    status: (resultSummary === "failed" ? "failed" : "done") as TaskStatus,
                    doneAt: FieldValue.serverTimestamp(),
                    totalTokens: s.total,
                    successCount: s.success,
                    invalidTokenCount: s.invalid,
                    failCount: s.fail,
                    lastError: s.lastError ?? null,
                    resultSummary,
                });
            }).catch(() => { });
        });
    }

    await runWithConcurrency(updateJobs, 20);

    return msgItems.length;
}

async function markDone(taskId: string, extra: Record<string, any>) {
    await db.collection("push_tasks").doc(taskId).update({
        status: "done" as TaskStatus,
        doneAt: FieldValue.serverTimestamp(),
        finalized: true,
        ...extra,
    });
}
