import { readFile } from "fs/promises";
import { issueApiKeyJwt } from "./apikey.js";

async function main() {
  const keySource = process.env.JWT_PRIVATE_KEY_PEM || "./ed25519_private.pem";

  // envにPEMを直で入れてるならそのまま、パスなら読む
  const privateKeyPem = keySource.includes("BEGIN PRIVATE KEY")
    ? keySource
    : await readFile(keySource, "utf8");

  const jwt = issueApiKeyJwt({
    privateKeyPem,
    kid: "k1",
    issuer: "my-issuer",
    audience: "push-kick",
    subject: "internal",
    shardId: 3,
    ttlSec: 120,
  });

  console.log(jwt);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
