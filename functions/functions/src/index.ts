import { onSchedule } from "firebase-functions/v2/scheduler";
import { logger } from "firebase-functions";
import { Timestamp } from "firebase-admin/firestore";
import { tryAcquireRunLock, releaseRunLock } from './workerlock.js';
import { action, SHARD_COUNT } from "./app.js";
import { onRequest } from 'firebase-functions/v2/https';
import { apiserver } from './apiserver.js';

const REGION = "asia-northeast1";
const TIME_ZONE = "Asia/Tokyo";



// v2 の onRequest にそのまま渡す
export const webauthn = onRequest({
    region: 'asia-northeast1'
}, apiserver);

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

        const start = Timestamp.now();

        // shard を順番に回す（SHARD_COUNT=1なら1回だけ）
        for (let sid = 0; sid < SHARD_COUNT; sid++) {
            try {
                const locked = await tryAcquireRunLock(sid);
                if (!locked) {
                    logger.info("pushWorker30m: skipped (run-lock busy)");
                    continue;
                }
                // shard個別にも lock したいならここで tryAcquireRunLock(sid) を入れる
                while (0 < (await action(sid) ?? 0)) {
                    const now = Timestamp.now();
                    if ((now.toMillis() - start.toMillis()) / 1000 > 480) break; // 8分で打ち切り等
                }
            } finally {
                await releaseRunLock(undefined);
            }
        }

    }
);

