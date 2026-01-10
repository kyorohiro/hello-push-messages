# How to Use

### create apikey

```
npx tsx ./src/main_gen_apikey.ts
```

### create pem for api lkey

```
npx tsx ./src/main_gen_apikey_pem.ts
```

### run api server 

```
npx tsx --watch ./src/main_apiserver.ts
```

## 



## x
cd functions 
npm run build
firebase deploy --only "functions:pushmessage:pushWorker" --project hello-push-messages


firebase deploy --only firestore:indexes --project hello-push-messages


`npx tsx src/main.ts`


```
import { generateKeyPairSync } from "crypto";
import { writeFileSync } from "fs";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");

writeFileSync("ed25519_public.pem", publicKey.export({ type: "spki", format: "pem" }));
writeFileSync("ed25519_private.pem", privateKey.export({ type: "pkcs8", format: "pem" }));

console.log("wrote ed25519_public.pem / ed25519_private.pem");

```

```
const PRIVATE_KEY_PEM = process.env.JWT_PRIVATE_KEY_PEM!; // Secretに入れる

const jwt = issueApiKeyJwt({
  privateKeyPem: PRIVATE_KEY_PEM,
  kid: "k1",
  issuer: "my-issuer",
  audience: "push-kick",
  subject: "internal",
  shardId: 3,
  ttlSec: 120,
});

console.log(jwt);

```


