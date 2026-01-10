import {admin} from "./firebase.js";

const auth = admin.auth();

// ---- options ----
const LIMIT = Number(process.argv[2] ?? "100"); // 表示最大件数

async function main() {
  console.log("> main")
  let nextPageToken: string | undefined = undefined;
  let count = 0;

  while (true) {
    const res = await auth.listUsers(1000, nextPageToken);

    for (const user of res.users) {
      console.log(
        `${user.uid}\t${user.email ?? ""}`
      );
      count++;
      if (count >= LIMIT) return;
    }

    if (!res.pageToken) break;
    nextPageToken = res.pageToken;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

