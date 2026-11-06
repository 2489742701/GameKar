/**
 * 一键出安卓**测试分发版** debug APK（2026-11-06）。
 *
 * 前置：npm run android:sync（会 build + 准备 dist-android + cap sync）。
 * 这里只做两件事：
 *  ① 用 Android Studio 自带 JBR(JDK 21) + 本机 Android SDK 跑 gradlew assembleDebug；
 *  ② 把 app-debug.apk 复制到 releases/GAMEKAR-arena-debug.apk。
 *
 * 为什么脚本里自动找 JDK/SDK：本机默认 java 是 1.8（AGP 8 要 17+），
 * ANDROID_HOME 也没设 —— 手工敲命令必踩这两个坑。
 * 可用环境变量 JAVA_HOME / ANDROID_HOME 覆盖。
 *
 * debug 签名只用于内部测试分发；正式上架要换 release 签名 + 版本号 + 备案。
 */
import { existsSync, mkdirSync, copyFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(import.meta.dirname ?? '.', '..');
const androidDir = resolve(root, 'android');
const jbr = 'C:\\Program Files\\Android\\Android Studio\\jbr';
const sdk = resolve(process.env.USERPROFILE ?? 'C:\\Users\\li', 'AppData/Local/Android/Sdk');

// 本机 env 里的 JAVA_HOME 可能是残留的无效路径（实测指向不存在的 Adoptium 目录），
// 所以一律先验证 bin/java.exe 真的存在，才敢用；否则回落 Android Studio 的 JBR(JDK 21)。
const usable = (home) => !!home && existsSync(resolve(home, 'bin/java.exe'));
const javaHome = usable(process.env.JAVA_HOME)
  ? process.env.JAVA_HOME
  : usable(jbr) ? jbr : undefined;
const androidHome = process.env.ANDROID_HOME ?? (existsSync(sdk) ? sdk : undefined);
if (!javaHome) throw new Error('找不到 JDK 17+：装 Android Studio 或设 JAVA_HOME');
if (!androidHome) throw new Error('找不到 Android SDK：设 ANDROID_HOME');
if (!existsSync(resolve(androidDir, 'gradlew.bat'))) throw new Error('没有 android/ 工程：先跑 npx cap add android');

const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  PATH: `${resolve(javaHome, 'bin')};${process.env.PATH ?? ''}`,
};

// Gradle 可执行：优先 env 指定，其次本机已解压的缓存（首次网络装不上时的兜底），
// 最后才用工程自带的 wrapper（wrapper 首次会联网下 gradle-8.11.1-all.zip）。
const localGradle = resolve(process.env.HOME ?? process.env.USERPROFILE ?? 'C:\\Users\\li', '.gradle/gradle-local/gradle-8.11.1/bin/gradle.bat');
const gradleBin = process.env.GRADLE_BIN ?? (existsSync(localGradle) ? localGradle : 'gradlew.bat');
const initScript = resolve(root, 'tools/android-init.gradle');
const args = [];
if (existsSync(initScript)) args.push('-I', initScript);
args.push('assembleDebug', '--no-daemon');

console.log(`JAVA_HOME=${javaHome}`);
console.log(`ANDROID_HOME=${androidHome}`);
console.log(`Gradle: ${gradleBin}`);
console.log(`${gradleBin.includes('gradlew') ? 'gradlew' : 'gradle'} assembleDebug …（第一次会下载依赖，可能要几分钟）`);
const r = spawnSync('cmd.exe', ['/c', gradleBin.includes('gradlew') ? 'gradlew.bat' : gradleBin, ...args], {
  cwd: androidDir,
  env,
  stdio: 'inherit',
});
if (r.status !== 0) throw new Error(`Gradle 失败（exit ${r.status}）`);

const apk = resolve(androidDir, 'app/build/outputs/apk/debug/app-debug.apk');
if (!existsSync(apk)) throw new Error('Gradle 说成功了但没找到 app-debug.apk');
mkdirSync(resolve(root, 'releases'), { recursive: true });
const dest = resolve(root, 'releases/GAMEKAR-arena-debug.apk');
copyFileSync(apk, dest);
console.log(`\n✅ 测试分发版：${dest}（${(statSync(dest).size / 1024 / 1024).toFixed(1)} MB）`);
