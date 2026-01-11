import fs from "node:fs";
import { issueApiKeyJwt } from "./apikey.js";

// 例: Cloud Functions のURL（あなたのやつ）
const KICK_URL =
  process.env.KICK_URL ||
  "https://asia-northeast1-hello-push-messages.cloudfunctions.net/pushMessage/push/kick";

// 署名用秘密鍵（PEM文字列を環境変数に入れてもOK）
const PRIVATE_KEY_PEM =
  process.env.JWT_PRIVATE_KEY_PEM ||
  fs.readFileSync(process.env.JWT_PRIVATE_KEY_PATH || "./_ed25519_private.pem", "utf8");

const KID = process.env.JWT_KID || "k1";
const ISSUER = process.env.JWT_ISSUER || "my-issuer";
const AUDIENCE = process.env.JWT_AUDIENCE || "push-kick";
const SUBJECT = process.env.JWT_SUBJECT || "internal";

// TTL短め推奨
const TTL_SEC = Number(process.env.JWT_TTL_SEC || 120);

function parseShardArg(arg: string | undefined): number | undefined {
  if (arg === undefined || arg === null || arg === "" || arg === "all") return undefined;
  const n = Number(arg);
  if (!Number.isFinite(n) || n < 0) throw new Error("Invalid shard. Use number or 'all'.");
  return n;
}

async function main() {
  // 使い方:
  // npx tsx src/main_kick_push_worker.ts            -> 全shard
  // npx tsx src/main_kick_push_worker.ts 3          -> shard=3
  // npx tsx src/main_kick_push_worker.ts all        -> 全shard
  const shard = parseShardArg(process.argv[2]);

  const jwt = issueApiKeyJwt({
    privateKeyPem: PRIVATE_KEY_PEM, // PEM文字列
    kid: KID,
    issuer: ISSUER,
    audience: AUDIENCE,
    subject: SUBJECT,
    shard: shard,
    ttlSec: TTL_SEC,
  });

  const body: any = {};
  if (shard !== undefined) body.shard = shard;

  const res = await fetch(KICK_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Kick failed: ${res.status} ${res.statusText}\n${text}`);
  }

  console.log(text);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});

