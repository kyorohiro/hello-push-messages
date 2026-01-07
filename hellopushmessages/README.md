# hellopushmessages

A new Flutter project.

## Android Setting 

```
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
        //sourceCompatibility = JavaVersion.VERSION_1_8
        //targetCompatibility = JavaVersion.VERSION_1_8
        isCoreLibraryDesugaringEnabled = true
    }
```

```
dependencies {
    //coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.0.4")
    coreLibraryDesugaring("com.android.tools:desugar_jdk_libs:2.1.4")
}
```


## iOS Setting


#### 0)

ios/Podfile

```
platform :ios, '15.0'
```

```
cd ios
rm -rf Pods Podfile.lock
pod repo update
pod install
cd ..
flutter clean
flutter run
```

#### 0) 

```
Certificates, Identifiers & Profiles
-> com.example.hellopushmessages
  --> Push Notifications (Broadcast Capability は false)
    --> configure Development SSL Certificate

```

#### 1) Apple Developer 側：APNs の Auth Key（.p8）を作る

Apple Developer の Keys で Apple Push Notifications service (APNs) のキーを作って、.p8 をダウンロードします。

https://developer.apple.com/help/account/keys/create-a-private-key/

```
In Certificates, Identifiers & Profiles, click Keys in the sidebar, then click the add button (+) on the top left.


1) Apple Developer の Certificates, Identifiers & Profiles を開く

2) 左メニューで Keys を選ぶ

3) 右上の 「+」(Add) を押す

4) Key Name を適当に入力

例：FCM APNs Key とか（後で探しやすい名前）

「Apple Push Notifications service (APNs)」 にチェックを入れる

これが “Push用の鍵” です

5) Continue → Register
Environment
Sandbox & Production
.p8 ファイルを Download（重要）

この .p8 は あとで再ダウンロードできません（基本 “一回だけ”）

6) 画面に出る Key ID を控える（例：ABCD1234EF みたいなやつ）

Name:comExampleHellopushmessagesKey
Key ID:8JPX2QL233
Services:Apple Push Notifications service (APNs)

7) Team ID も控える

5H7KW7PC7C

```


#### 2) Firebase Console 側：APNs Key をアップロード

Firebase Console → Project settings → Cloud Messaging → Apple app configuration のところで、


#### 3) Xcode 側：Push能力をON（Capabilities）

iOSアプリ（Runner）で
Signing & Capabilities → Push Notifications を追加
必要なら Background Modes → Remote notifications をON
Runner (Target) → Signing & Capabilities
