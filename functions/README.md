cd functions 
npm run build
firebase deploy --only "functions:pushmessage:pushWorker" --project hello-push-messages


firebase deploy --only firestore:indexes --project hello-push-messages