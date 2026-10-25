// SDK-only debug build. No Gradle downloads, release keys or device installation.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sdk = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
if (!sdk) throw Error('Set ANDROID_SDK_ROOT or ANDROID_HOME to an Android SDK with platform 35 and build-tools 35.0.0.');
const jdk = process.env.JAVA_HOME;
const javaTool = name => jdk ? path.join(jdk, 'bin', name + (process.platform === 'win32' ? '.exe' : '')) : name;
const tools = path.join(sdk, 'build-tools', '35.0.0');
const androidTool = name => path.join(tools, name + (process.platform === 'win32' ? (['d8', 'apksigner'].includes(name) ? '.bat' : '.exe') : ''));
const platform = path.join(sdk, 'platforms', 'android-35', 'android.jar');
if (!fs.existsSync(platform)) throw Error('Missing Android SDK platform 35. See docs/canvaslink.md.');
const build = path.join(root, 'build', 'android'), dist = path.join(root, 'dist'), runtime = path.join(root, '.runtime');
fs.rmSync(build, { recursive: true, force: true });
for (const dir of [build, dist, runtime, path.join(build, 'classes'), path.join(build, 'dex')]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
function run(binary, args) {
  const result = spawnSync(binary, args, { stdio: 'inherit', shell: process.platform === 'win32' && binary.endsWith('.bat') });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${path.basename(binary)} exited ${result.status}`);
}
// Device acceptance instrumentation remains source-only and is never shipped.
const files = ['MainActivity', 'TerminalWebView', 'Srp', 'SessionVault'].map(name => path.join(root, 'android', 'src', 'io', 'nexcore', 'canvaslink', name + '.java'));
run(javaTool('javac'), ['--release', '8', '-cp', platform, '-d', path.join(build, 'classes'), ...files]);
run(javaTool('jar'), ['cf', path.join(build, 'classes.jar'), '-C', path.join(build, 'classes'), '.']);
run(androidTool('d8'), ['--release', '--min-api', '26', '--lib', platform, '--output', path.join(build, 'dex'), path.join(build, 'classes.jar')]);
const compiled = path.join(build, 'resources.zip');
run(androidTool('aapt2'), ['compile', '--dir', path.join(root, 'android', 'res'), '-o', compiled]);
run(androidTool('aapt2'), ['link', '-o', path.join(build, 'base.apk'), '--manifest', path.join(root, 'android', 'AndroidManifest.xml'), '-I', platform, '-A', path.join(root, 'android', 'assets'), compiled]);
run(javaTool('jar'), ['uf', path.join(build, 'base.apk'), '-C', path.join(build, 'dex'), 'classes.dex']);
run(androidTool('zipalign'), ['-f', '-p', '4', path.join(build, 'base.apk'), path.join(build, 'aligned.apk')]);
const keystore = path.join(runtime, 'debug.keystore');
if (!fs.existsSync(keystore)) {
  run(javaTool('keytool'), ['-genkeypair', '-keystore', keystore, '-alias', 'canvaslink-debug', '-storepass', 'android', '-keypass', 'android', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '3650', '-dname', 'CN=CanvasLink Local Development']);
  fs.chmodSync(keystore, 0o600);
}
const apk = path.join(dist, 'CanvasLink-debug.apk');
run(androidTool('apksigner'), ['sign', '--ks', keystore, '--ks-key-alias', 'canvaslink-debug', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', apk, path.join(build, 'aligned.apk')]);
run(androidTool('apksigner'), ['verify', '--verbose', apk]);
console.log(`Built ${path.relative(root, apk)} (local development signature; not a release build)`);
