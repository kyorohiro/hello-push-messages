Push notification system that assumes 10,000,000 notifications/day per minute


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

```
curl -X "POST" -H "Authorization: Bearer eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCIsImtpZCI6ImsxIn0.eyJpYXQiOjE3NjgwNjU3OTUsImV4cCI6MTc2ODA2NTkxNSwianRpIjoiZmRhNDdiOTktZjBjZC00YjFhLWExMzEtYWNkZDIwYzRlNzRlIiwiaXNzIjoibXktaXNzdWVyIiwiYXVkIjoicHVzaC1raWNrIiwic3ViIjoiaW50ZXJuYWwiLCJzaGFyZElkIjozfQ.8sp29IL2wEXkQaLFB3VsDyG332urmCxckEv_n0JNUrP-VEFumxL40xWnhP8yZJYSmwc8V29f-raYUSsFZwyDBg" http://0.0.0.0:3000/push/kick -H "content-type: application/json" -d '{"shardId":0}'
```

```
curl http://0.0.0.0:3000/hello
```

curl -X "POST" -H "Authorization: Bearer .." http://0.0.0.0:3000/push/kick -d "{shardId:1}"



# Deploy

```

cd functions 
npm run build
firebase deploy --only "functions:pushmessage:pushWorker" --project hello-push-messages
firebase deploy --only "functions:pushmessage:pushMessage" --project hello-push-messages

firebase deploy --only firestore:indexes --project hello-push-messages
```
