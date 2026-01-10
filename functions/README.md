Push notification system that assumes 10,000,000 notifications/day per minute


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
shardId を 0-{コードで設定} の 数字を指定してください

```
curl -X "POST" -H "Authorization: Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImsxIn0.eyJpYXQiOjE3NjgwNjU3OTUsImV4cCI6MTc2ODA2NTkxNSwianRpIjoiZmRhNDdiOTktZjBjZC00YjFhLWExMzEtYWNkZDIwYzRlNzRlIiwiaXNzIjoibXktaXNzdWVyIiwiYXVkIjoicHVzaC1raWNrIiwic3ViIjoiaW50ZXJuYWwiLCJzaGFyZElkIjozfQ.8sp29IL2wEXkQaLFB3VsDyG332urmCxckEv_n0JNUrP-VEFumxL40xWnhP8yZJYSmwc8V29f-raYUSsFZwyDBg" http://0.0.0.0:3000/push/kick -H "content-type: application/json" -d '{"shardId":0}'
```

動作確認用


```
curl http://0.0.0.0:3000/hello
```

APIKEYの動作確認用

curl  -H "Authorization: Bearer .." http://0.0.0.0:3000/check




# Deploy

自動でビルドされないので注意

```

cd functions 
npm run build
firebase deploy --only "functions:pushmessage:pushWorker" --project hello-push-messages
firebase deploy --only "functions:pushmessage:pushMessage" --project hello-push-messages

firebase deploy --only firestore:indexes --project hello-push-messages
```
