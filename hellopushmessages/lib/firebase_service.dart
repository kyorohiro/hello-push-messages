import 'package:firebase_auth/firebase_auth.dart';

Future<User> ensureSignedIn() async {
  final auth = FirebaseAuth.instance;

  // 既に復元済みなら即返す
  final existing = auth.currentUser;
  if (existing != null) return existing;

  // 1回だけ状態変化を待つ（復元が走るのを待つ）
  final user = await auth.authStateChanges().first;

  if (user != null) return user;

  // それでも null なら本当に未ログインなので匿名ログイン
  final cred = await auth.signInAnonymously();
  return cred.user!;
}
