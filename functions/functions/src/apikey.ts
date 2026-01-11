import type { Request } from "express";
import fs from "node:fs";
import { jwtVerify, importSPKI } from "jose";
import { createPrivateKey, sign, randomUUID } from "crypto";

const PUBLIC_KEY_PEM_PATH = "./ed25519_public.pem"; // ここは好きに
const ISSUER = "my-issuer";
const AUDIENCE = "push-kick";

// 起動時に1回だけ読む（ホットリロードしたいならfs.watch等）
const publicKeyPem = fs.readFileSync(PUBLIC_KEY_PEM_PATH, "utf8");
const publicKey = await importSPKI(publicKeyPem, "EdDSA");

export async function verifyJwtFromRequest(req: Request) {
  const auth = req.header("authorization") || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("missing bearer token");

  const token = m[1];
  return verifyJwtFromToekn(token);
}

async function verifyJwtFromToekn(token:any) {
  const { payload, protectedHeader } = await jwtVerify(token, publicKey, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });

  // kid を見たいなら
  console.log("kid:", protectedHeader.kid);

  return payload; // { sub, shard, ... } が返る
}

//
// Base64URL エンコード（JWT仕様）
//
function b64url(input: Buffer | string) {
    const buf = typeof input === "string" ? Buffer.from(input) : input;
    return buf
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
}

type IssueJwtOptions = {
    privateKeyPem: string;     // PKCS8 PEM (-----BEGIN PRIVATE KEY-----)
    kid?: string;              // 任意（将来ローテ用）
    issuer?: string;           // iss
    audience?: string;         // aud
    subject?: string;          // sub
    shard?: number;          // action(shard) 用
    ttlSec?: number;           // 例: 60 〜 300 推奨
};

function issueApiKeyJwt(opts: IssueJwtOptions): string {
    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(1, opts.ttlSec ?? 120);

    const header: Record<string, any> = {
        alg: "EdDSA",
        typ: "JWT",
        ...(opts.kid ? { kid: opts.kid } : {}),
    };

    // 必要最小限 + 運用で便利なもの
    const payload: Record<string, any> = {
        iat: now,
        exp: now + ttl,
        jti: randomUUID(), // リプレイ対策をやりたければ使う
        ...(opts.issuer ? { iss: opts.issuer } : {}),
        ...(opts.audience ? { aud: opts.audience } : {}),
        ...(opts.subject ? { sub: opts.subject } : {}),
        ...(opts.shard !== undefined ? { shard: opts.shard } : {}),
    };

    const encodedHeader = b64url(JSON.stringify(header));
    const encodedPayload = b64url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;

    const key = createPrivateKey(opts.privateKeyPem);
    const signature = sign(null, Buffer.from(signingInput), key); // Ed25519は digest=null
    const encodedSig = b64url(signature);

    return `${signingInput}.${encodedSig}`;
}


export {
    issueApiKeyJwt
}