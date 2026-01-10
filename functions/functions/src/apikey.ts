import jwt from "jsonwebtoken";
import jwkToPem from "jwk-to-pem";
import { createPrivateKey, sign, randomUUID } from "crypto";

// ---- Auth / JWKS ----
const ISSUE_JWKS_URL = process.env.ISSUE_JWKS_URL!; // 例: https://example.com/issue
const JWT_ISSUER = process.env.JWT_ISSUER!;         // 例: https://example.com/
const JWT_AUDIENCE = process.env.JWT_AUDIENCE!;     // 例: my-api
const JWKS_TTL_MS = 10 * 60 * 1000; // 10分キャッシュ

import { readFile } from "fs/promises";
import { createPublicKey, KeyObject } from "crypto";

type PublicKeyCache = {
  fetchedAt: number;
  key: KeyObject;
  pem: string;
};

let pubKeyCache: PublicKeyCache | null = null;

//
const PUBLIC_KEY_PEM_PATH = "./ed25519_public.pem"; 
// ↑ Functionsのデプロイに同梱するなら相対パスでOK（配置に合わせて調整）
// 例: functions/src/ から読むなら "../ed25519_public.pem" など
type JwksKeyLike = {
  kty: "OKP";
  crv: "Ed25519";
  use?: "sig";
  alg?: "EdDSA";
  kid?: string;
  // ここでは実運用のために KeyObject を直接持たせる（JWKSの形に寄せつつ）
  _keyObject: import("crypto").KeyObject;
};

let jwksCache: { fetchedAt: number; keys: JwksKeyLike[] } | null = null;

async function getJwksKeys(): Promise<any[]> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;

  const pem = await readFile(PUBLIC_KEY_PEM_PATH, "utf8");
  const keyObj = createPublicKey(pem);

  jwksCache = {
    fetchedAt: now,
    keys: [
      {
        kty: "OKP",
        crv: "Ed25519",
        use: "sig",
        alg: "EdDSA",
        kid: "k1",          // 固定でいいならここ
        _keyObject: keyObj, // ← verifyでこれを使う
      },
    ],
  };

  return jwksCache.keys;
}

// Node18+ の fetch を使う前提（Functions v2 / Cloud RunならOK）
//type Jwks = { keys: any[] };
//let jwksCache: { fetchedAt: number; keys: any[] } | null = null;
//async function getJwksKeys(): Promise<any[]> {
//     const now = Date.now();
//     if (jwksCache && now - jwksCache.fetchedAt < JWKS_TTL_MS) return jwksCache.keys;
// 
//     const res = await fetch(ISSUE_JWKS_URL, { method: "GET" });
//     if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
// 
//     const jwks = (await res.json()) as Jwks;
//     if (!jwks?.keys?.length) throw new Error("JWKS has no keys");
// 
//     jwksCache = { fetchedAt: now, keys: jwks.keys };
//     return jwks.keys;
//}

async function verifyJwtFromRequest(req: any): Promise<any> {
    const auth = req.headers?.authorization ?? "";
    const m = /^Bearer\s+(.+)$/.exec(auth);
    if (!m) throw new Error("missing bearer token");

    const token = m[1];

    // kid 取得（署名検証前にヘッダだけ読む）
    const decoded = jwt.decode(token, { complete: true }) as any;
    const kid = decoded?.header?.kid;
    if (!kid) throw new Error("missing kid");

    const keys = await getJwksKeys();
    const jwk = keys.find((k) => k.kid === kid);
    if (!jwk) throw new Error("unknown kid");

    const pem = jwkToPem(jwk);

    // iss/aud/exp などを検証
    return jwt.verify(token, pem, {
        algorithms: ["RS256"], // 必要なら調整
        issuer: JWT_ISSUER,
        audience: JWT_AUDIENCE,
    });
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
    shardId?: number;          // action(shardId) 用
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
        ...(opts.shardId !== undefined ? { shardId: opts.shardId } : {}),
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
    verifyJwtFromRequest,
    getJwksKeys,
    issueApiKeyJwt
}