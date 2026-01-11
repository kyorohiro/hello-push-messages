import type { Request, Response } from "express";
import express from "express";
import { tryAcquireRunLock, releaseRunLock } from './workerlock.js';
import { verifyJwtFromRequest } from './apikey.js';
import { action, SHARD_COUNT } from './app.js';

export const pushRouter = express.Router();
const apiserver = express();
apiserver.use(express.json());

function errorHandler(err: any, req: any, res: any, next: any) {
    console.log("> errorHandler")
    console.log(err);
    res.status(500)
    res.send(JSON.stringify({error: `${err}`}))
}

pushRouter.post("/kick", async (req: Request, res: Response) => {
    console.log("> kick", req.body)
    try {
        // JWT guard（/issue から JWKS を取って検証）
        const claims = await verifyJwtFromRequest(req);

        // shard optional
        const shardRaw = req.body?.shard |  req.body?.shardId;
        const shard =
            shardRaw === undefined || shardRaw === null
                ? undefined
                : Number(shardRaw);

        if (shard !== undefined && (!Number.isFinite(shard) || shard < 0 || shard >= SHARD_COUNT)) {
            return res.status(400).json({ ok: false, error: "invalid shard" });
        }

        // 重複防止（kick 実行ロック）
        const locked = await tryAcquireRunLock(shard);
        if (!locked) {
            return res.status(409).json({ ok: false, error: "busy" });
        }

        try {
            let processed = 0;
            const start = Date.now();

            // kick は短く（必要ならループ）
            while (0 < (await action(shard) ?? 0)) {
                processed++;
                if (Date.now() - start > 60_000) break; // kickは1分で打ち切り等
            }

            return res.json({ ok: true, shard: shard ?? "all", processed, sub: claims?.sub ?? null });
        } finally {
            await releaseRunLock(shard);
        }
    } catch (e: any) {
        return res.status(401).json({ ok: false, error: String(e?.message ?? e) });
    }
});

apiserver.use("/push", pushRouter);
apiserver.get("/check", async (req, res, next) => {
    try {
        res.send(JSON.stringify({ verify: await verifyJwtFromRequest(req) }))
    } catch (e) {
        next(e);
    }
});
apiserver.get("/hello", (req, res, next) => {
    try {
        res.send(JSON.stringify({ message: "hello" }))
    } catch (e) {
        next(e);
    }
});

apiserver.use(errorHandler);

export { apiserver }