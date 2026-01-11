/**
 * shared は 無視して、全てのTaskを実行
 * ただし、 Indexの設定が必要
 * {
 *  "indexes": [
 *    {
 *      "collectionGroup": "push_tasks",
 *      "queryScope": "COLLECTION",
 *      "fields": [
 *        { "fieldPath": "status", "order": "ASCENDING" },
 *        { "fieldPath": "scheduledAt", "order": "ASCENDING" }
 *      ]
 *    },
 * ...
*/
import { action } from "./app.js";
const main = async () => {
    console.log("hello");
    action(undefined);
};

main();