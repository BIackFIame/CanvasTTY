const { execFileSync } = require("node:child_process");
const { copyFileSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { Arch } = require("builder-util");

exports.default = async function afterPack(context) {
  if (context.electronPlatformName === "win32") {
    // Electron's native rebuild can remove the runtime files copied by node-pty's npm postinstall.
    const architecture = Arch[context.arch];
    if (architecture !== "x64" && architecture !== "arm64") throw new Error(`Unsupported ConPTY architecture: ${architecture}`);
    const source = join(context.packager.projectDir, "node_modules/node-pty/third_party/conpty/1.23.251008001", `win10-${architecture}`);
    const destination = join(context.appOutDir, "resources/app.asar.unpacked/node_modules/node-pty/build/Release/conpty");
    mkdirSync(destination, { recursive: true });
    for (const file of ["conpty.dll", "OpenConsole.exe"]) copyFileSync(join(source, file), join(destination, file));
    return;
  }
  // CanvasTTY Edge does not update itself: no Sparkle key or feed goes into its Info.plist.
  if (context.electronPlatformName !== "darwin" || process.env.CANVASTTY_EDGE_SPARKLE !== "1") return;
  const key = process.env.SPARKLE_PUBLIC_ED_KEY;
  if (!key || !/^[A-Za-z0-9+/]{43}=$/.test(key) || Buffer.from(key, "base64").length !== 32) {
    throw new Error("SPARKLE_PUBLIC_ED_KEY must be the owner's 32-byte Ed25519 public key in base64");
  }
  const plist = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents", "Info.plist");
  const set = (...args) => execFileSync("plutil", args.concat(plist));
  set("-insert", "SUPublicEDKey", "-string", key);
  set("-insert", "SUFeedURL", "-string", "https://github.com/howdeploy/CanvasTTY/releases/latest/download/appcast.xml");
  set("-insert", "SUEnableAutomaticChecks", "-bool", "NO");
  set("-insert", "SUAutomaticallyUpdate", "-bool", "NO");
  set("-insert", "SUVerifyUpdateBeforeExtraction", "-bool", "YES");
  set("-insert", "SURequireSignedFeed", "-bool", "YES");
  set("-insert", "SUSignedFeedFailureExpirationInterval", "-integer", "0");
};
