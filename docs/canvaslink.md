# CanvasLink for Android (experimental alpha)

CanvasLink streams the **whole current CanvasTTY window** to an Android phone or
tablet on the same private IPv4 LAN. Touch, terminal keyboard input and shortcuts
are delivered to that window. This includes Settings and any sensitive content
visible in it. Enable access only for a device you trust.

The host lives in **Settings → CanvasLink**. There is no separate desktop app to
install. It starts **off** on every desktop launch. The existing Web companion
and Even G2 integration retain their separate pairing and permissions.

## Connect

1. Install the development APK from a trusted build of this branch (Android 8+).
2. Open Settings → CanvasLink on the desktop and choose **Enable access**.
3. Open CanvasLink on Android, select the discovered computer and enter the six
   digits shown on the desktop. The code expires after two minutes and is used
   once. If discovery is blocked, the Android connection screen has a manual
   private IPv4 address option. Both devices must be on the same non-isolated LAN.
4. Tap a terminal to open the Android keyboard. Text goes directly into the
   focused terminal; Enter executes it. The shortcut bar includes paste and
   interrupt. Zoom/pan can bring a terminal into view.
5. **Forget device** revokes its session and generates a new code. **Turn off
   access** closes the listener, discovery, video and input. A desktop restart
   requires fresh pairing. Sessions expire after twelve hours and are bound to
   the client's address; a changed address can require pairing again.

The app distinguishes processed, pending and uncertain input. A disconnect does
not automatically replay a command. Check the terminal before retrying uncertain
input. Clipboard paste uses the Android clipboard; it does not read the desktop
clipboard.

## Transport and boundaries

- Host listener: private IPv4 clients on TCP 3499; mDNS `_canvaslink._tcp` discovery.
  Do not expose or forward this port to the Internet. Networks may require an
  inbound firewall allowance. No firewall rule or startup service is installed.
- No cloud service, STUN or TURN. Pairing uses SRP-6a; the code is not sent as
  plaintext. Signalling uses AES-256-GCM with authenticated sequence numbers;
  WebRTC media/data use DTLS-SRTP/SCTP encryption. The HTTP endpoint is not HTTPS;
  the application protocol supplies the encryption.
- Pairing attempts and request sizes are bounded. A code authorizes the **whole
  window**, not a selected-session grant. Treat the Android device as a keyboard
  and pointer with the same authority as the person at that window.
- Electron capture is restricted to CanvasTTY's own main frame; input uses its
  `webContents`, never OS-wide keyboard or pointer injection. This integrated
  path does not require Accessibility control of other applications.
- A hidden isolated renderer handles media. Its IPC and the settings IPC reject
  other renderers and child frames. Private test sockets, startup automation,
  instrumentation entry points and global input helpers are not shipped.

## Build

From the repository root:

```sh
npm ci
npx playwright install chromium
npm run test:canvaslink
npm run typecheck
npm run build
```

For the APK, install JDK 17 and Android SDK platform 35/build-tools 35.0.0, set
`JAVA_HOME` and `ANDROID_SDK_ROOT` (or `ANDROID_HOME`), then run:

```sh
npm run build:canvaslink:android
```

Output: `integrations/canvaslink/dist/CanvasLink-debug.apk`. No Gradle or Android
Java dependencies are downloaded by the build script. A local development key
is generated under the ignored `.runtime` directory. CI produces an APK artifact
with an ephemeral development signature. Different builds can have different
keys and may not install as an update over one another. Keep your existing app
and its data until you have planned the transition. Release signing/distribution
is not configured by this PR.

## Quality and platform status

The prototype was physically tested on macOS with an Android 12 tablet and
accepted by its user before this source port. That acceptance applies to the
prototype APK/preview, not automatically to a newly packaged desktop or APK.
See [the port verification record](canvaslink-verification.md).

Windows and Linux have not received physical device acceptance. Their shared
Electron path and JavaScript discovery implementation are candidates for testing,
not a verified compatibility promise. CI tests contracts and builds an APK; it
cannot establish real IME, GPU capture, firewall or touch behavior on those hosts.

Capture first tries the owned renderer stream and falls back to bounded raw
snapshots (up to 2560×1600). The prototype's observed fallback was around 3–6 FPS;
30 FPS is not promised. High density can improve text clarity at a cost in CPU
and bandwidth. Normal desktop density is unchanged. For an isolated developer
run, `--force-device-scale-factor=2` supplies density at process start, or
`--canvaslink-high-density` requests one relaunch with that switch. Never enable
this while preserving an active terminal session without planning the restart.

Before promotion beyond alpha: test a packaged build with a physical Android
device on macOS, Windows and Linux; include discovery, pairing/revocation,
Settings touch, native selects, IME composition, Ctrl+C/paste, Unicode, rotation,
background/resume, network loss, minimized/closed windows and capture quality.

Краткая инструкция по-русски: [canvaslink.ru.md](canvaslink.ru.md).
