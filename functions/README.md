Push notification system that assumes 10,000,000 notifications/day per minute

firestoreに、

```
{
userId:string
title:string
message:string
}
```

の形式で、`/push_tasks/{taskId}`にMessageをアップすると、
Push通知を送信します。

送信先は、

```
{
    platform:string
    token:string
}
```

の形式で  `/user/{uid}/push_tokens/{tokenId}` の Deviceになります




# How to prepare

```
import serviceAccountJson from "../../hello-push-messages-firebase-adminsdk-fbsvc-4f52542438.json" with { type: "json" };
```

を任意のファイル名に変える


APIKEY は 秘密鍵から、生成する。

```
npx tsx ./src/main_gen_apikey.ts

_ed25519_public.pem
_ed25519_private.pem
に名前を変えてください
```


Deployする

```
cd functions 
npm run build
firebase deploy --only "functions:pushmessage:pushWorker" --project hello-push-messages
firebase deploy --only "functions:pushmessage:pushMessage" --project hello-push-messages

firebase deploy --only firestore:indexes --project hello-push-messages
```



# How to Use

### create apikey

APIKEY は 秘密鍵から、生成する。

```
npx tsx ./src/main_gen_apikey.ts

_ed25519_public.pem
_ed25519_private.pem
に名前を変えてください
```



### create pem for api lkey

秘密鍵は以下で生成する

```
npx tsx ./src/main_gen_apikey_pem.ts
```

### run api server 

APIサーバーの起動
```
npx tsx --watch ./src/main_apiserver.ts
```

通知送信WorkerをKICKする
shard を 0-{コードで設定} の 数字を指定してください

```
curl -X "POST" -H "Authorization: Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImsxIn0.eyJpYXQiOjE3NjgwNjU3OTUsImV4cCI6MTc2ODA2NTkxNSwianRpIjoiZmRhNDdiOTktZjBjZC00YjFhLWExMzEtYWNkZDIwYzRlNzRlIiwiaXNzIjoibXktaXNzdWVyIiwiYXVkIjoicHVzaC1raWNrIiwic3ViIjoiaW50ZXJuYWwiLCJzaGFyZElkIjozfQ.8sp29IL2wEXkQaLFB3VsDyG332urmCxckEv_n0JNUrP-VEFumxL40xWnhP8yZJYSmwc8V29f-raYUSsFZwyDBg" http://0.0.0.0:3000/push/kick -H "content-type: application/json" -d '{"shard":0}'
```

動作確認用


```
curl http://0.0.0.0:3000/hello
```

APIKEYの動作確認用

curl  -H "Authorization: Bearer .." http://0.0.0.0:3000/check



#### ユーザー一覧取得

```
npx tsx src/main_list_users.ts
```

#### ユーザーIDとtitleとmessge を指定してPush通知を送信

```
npx tsx src/main_enqueue_push_task.ts <USER_UID> "テスト" "本文"
npx tsx src/main_enqueue_push_task.ts <USER_UID> "テスト" "本文" "2026-01-11T23:10:00+09:00"
```

#### API Server へ 疎通確認

```
curl https://asia-northeast1-hello-push-messages.cloudfunctions.net/pushMessage/hello
```



# Deploy

自動でビルドされないので注意

hello-push-messages は 仮の名前

```

cd functions 
npm run build
firebase deploy --only "functions:pushmessage:pushWorker" --project hello-push-messages
firebase deploy --only "functions:pushmessage:pushMessage" --project hello-push-messages

firebase deploy --only firestore:indexes --project hello-push-messages
```

