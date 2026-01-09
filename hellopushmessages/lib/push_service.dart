import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/material.dart';
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:hellopushmessages/firebase_options.dart';
import 'package:flutter/foundation.dart' show kIsWeb, defaultTargetPlatform;

@pragma('vm:entry-point')
Future<void> firebaseMessagingBackgroundHandler(RemoteMessage message) async {
  // 背景 isolate では Firebase が初期化されてない可能性があるので初期化する
  await Firebase.initializeApp(options: DefaultFirebaseOptions.currentPlatform);

  // NOTE:
  // Android/iOS でバックグラウンド時の「通知表示」は
  // FCM の notification payload があれば OS が出すことが多い。
  // data-only の場合などはここで処理が必要になる。
}

class PushService {
  final FlutterLocalNotificationsPlugin flnp =
      FlutterLocalNotificationsPlugin();

  PushService._();

  static final instance = PushService._();

  Future<void> initLocalNotificationsIfSupported() async {
    // flutter_local_notifications は Web では基本使わない（未サポート/制約あり）
    if (kIsWeb) return;

    const androidInit = AndroidInitializationSettings('@mipmap/ic_launcher');

    const darwinInit = DarwinInitializationSettings(
      requestAlertPermission: true,
      requestBadgePermission: true,
      requestSoundPermission: true,
    );

    const initSettings = InitializationSettings(
      android: androidInit,
      iOS: darwinInit,
    );

    await flnp.initialize(
      initSettings,
      onDidReceiveNotificationResponse: (NotificationResponse r) {
        // 通知タップ時の処理（payload があれば r.payload）
        // ここで画面遷移したいなら navigator key を使うのが定番
      },
    );

    // Android のフォアグラウンド通知表示用にチャンネルを作る（Androidのみ）
    final androidPlugin = flnp
        .resolvePlatformSpecificImplementation<
          AndroidFlutterLocalNotificationsPlugin
        >();
    if (androidPlugin != null) {
      const channel = AndroidNotificationChannel(
        'high_importance_channel',
        'High Importance Notifications',
        description: 'Used for important notifications.',
        importance: Importance.high,
      );
      await androidPlugin.createNotificationChannel(channel);
    }
  }

  Future<void> initFirebaseMessaging() async {
    // Background handler は Firebase init の後に登録しておくのが安全
    FirebaseMessaging.onBackgroundMessage(firebaseMessagingBackgroundHandler);

    //
    // 初期化時でなくて任意のタイミングで行う
    // 通知許可（Android 13+ / iOS）
    //await FirebaseMessaging.instance.requestPermission(
    //  alert: true,
    //  badge: true,
    //  sound: true,
    //);

    // iOS: フォアグラウンドでも OS 側に表示させたい場合
    // （Android は基本 onMessage でローカル通知を出す）
    if (!kIsWeb) {
      await FirebaseMessaging.instance
          .setForegroundNotificationPresentationOptions(
            alert: true,
            badge: true,
            sound: true,
          );
    }

    // フォアグラウンド受信（Androidはここでローカル通知を出すのが基本）
    FirebaseMessaging.onMessage.listen((RemoteMessage message) async {
      if (kIsWeb) {
        // Web は別実装（通知は Service Worker 側が主体）
        debugPrint('onMessage(Web): ${message.messageId}');
        return;
      }

      final notification = message.notification;
      final android = message.notification?.android;

      // Android: フォアグラウンドでも通知表示したい場合にローカル通知を出す
      if (notification != null && android != null) {
        await flnp.show(
          notification.hashCode,
          notification.title,
          notification.body,
          const NotificationDetails(
            android: AndroidNotificationDetails(
              'high_importance_channel',
              'High Importance Notifications',
              channelDescription: 'Used for important notifications.',
              importance: Importance.high,
              priority: Priority.high,
            ),
          ),
        );
      }
    });

    // 通知タップでアプリが開いた場合
    FirebaseMessaging.onMessageOpenedApp.listen((RemoteMessage message) {
      debugPrint('onMessageOpenedApp: ${message.messageId}');
    });

    // FCM token（まずはログに出す）
    final token = await FirebaseMessaging.instance.getToken();
    debugPrint('FCM token: $token');

    // TODO: ここで token を Firestore / API に保存
    // さらに確実にするなら onTokenRefresh も保存
    FirebaseMessaging.instance.onTokenRefresh.listen((t) {
      debugPrint('FCM token refreshed: $t');
      // TODO: 保存処理
    });
  }

  // 任意タイミングで呼ぶ
  Future<bool> askNotificationPermission() async {
    final fm = FirebaseMessaging.instance;

    final settings = await fm.requestPermission(
      alert: true,
      badge: true,
      sound: true,
    );

    final ok =
        settings.authorizationStatus == AuthorizationStatus.authorized ||
        settings.authorizationStatus == AuthorizationStatus.provisional;

    if (!ok) return false;

    // iOS: フォアグラウンドでもOS表示させたい
    if (!kIsWeb && defaultTargetPlatform == TargetPlatform.iOS) {
      await fm.setForegroundNotificationPresentationOptions(
        alert: true,
        badge: true,
        sound: true,
      );
    }

    // token取得→保存（/user/{uid}/push_tokens/{tokenId}）
    final token = await fm.getToken();
    debugPrint('FCM token: $token');
    // TODO: 保存処理

    // refresh は補助として保存
    fm.onTokenRefresh.listen((t) {
      debugPrint('FCM token refreshed: $t');
      // TODO: 保存処理
    });

    return true;
  }
}
