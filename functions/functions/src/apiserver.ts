import type { Request, Response } from "express";
import express from "express";
import { tryAcquireRunLock, releaseRunLock } from './workerlock.js';
import { verifyJwtFromRequest } from './apikey.js';
import { action, SHARD_COUNT } from './app.js';

export const pushRouter = express.Router();
const apiserver = express();

pushRouter.post("/kick", async (req: Request, res: Response) => {
  try {
    // JWT guard（/issue から JWKS を取って検証）
    const claims = await verifyJwtFromRequest(req);

    // shardId optional
    const shardIdRaw = req.body?.shardId;
    const shardId =
      shardIdRaw === undefined || shardIdRaw === null
        ? undefined
        : Number(shardIdRaw);

    if (shardId !== undefined && (!Number.isFinite(shardId) || shardId < 0 || shardId >= SHARD_COUNT)) {
      return res.status(400).json({ ok: false, error: "invalid shardId" });
    }

    // 重複防止（kick 実行ロック）
    const locked = await tryAcquireRunLock(shardId);
    if (!locked) {
      return res.status(409).json({ ok: false, error: "busy" });
    }

    try {
      let processed = 0;
      const start = Date.now();

      // kick は短く（必要ならループ）
      while (0 < (await action(shardId) ?? 0)) {
        processed++;
        if (Date.now() - start > 60_000) break; // kickは1分で打ち切り等
      }

      return res.json({ ok: true, shardId: shardId ?? "all", processed, sub: claims?.sub ?? null });
    } finally {
      await releaseRunLock(shardId);
    }
  } catch (e: any) {
    return res.status(401).json({ ok: false, error: String(e?.message ?? e) });
  }
});

apiserver.use("/push", pushRouter);
apiserver.get("/check", (req, res) =>{
    res.send(JSON.stringify({ message: "hello"}))
});

export { apiserver }