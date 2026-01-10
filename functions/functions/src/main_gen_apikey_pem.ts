import { generateKeyPairSync } from "crypto";
import { writeFileSync } from "fs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

writeFileSync("ed25519_public.pem", publicKey.export({ type: "spki", format: "pem" }));
writeFileSync("ed25519_private.pem", privateKey.export({ type: "pkcs8", format: "pem" }));

console.log("wrote ed25519_public.pem / ed25519_private.pem");
