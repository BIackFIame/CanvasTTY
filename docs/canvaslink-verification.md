# CanvasLink alpha: verification scope

Follow-up: [2026-10-26 security/failure-path audit](canvaslink-security-audit-2026-10-26.md)
records six fixed findings, 115 passing integration tests, dependency issues and
the remaining native/runtime acceptance gaps. The older counts below describe
the earlier source-port and distribution snapshots.

The source port is based on upstream commit
`0fa6895d3675b40ec4dc75886826dd2db234c234` (package version 1.8.1).
It does not replace the user's installed CanvasTTY 1.8.2 or its active preview.

## Prior prototype acceptance

The user manually exercised the macOS/Android prototype and confirmed it worked
before publication preparation. Its installed APK SHA-256 was
`48b967d7102c8e733666a630562b420e5bee5ac3bc734ad065d7a89ffd038783`.
Prior bounded device checks covered real terminal input/ACKs, Settings touch,
native selects, resume, Wi-Fi and high-density capture on Android 12.
This is prototype evidence, not device acceptance of this source-port package.

## Source-port checks

- General upstream suite in an isolated source snapshot with a clean environment:
  2,221 passed, 27 skipped, zero failures. No Go toolchain was present; native-helper
  parity/release coverage is not claimed.
- 103 CanvasLink tests passed: pairing/authentication/replay rejection, input
  ordering and uncertainty, reconnect races, direct-input/gesture fixtures,
  select/touch behavior, graphics bounds, icons and IPC/lifecycle ownership.
- TypeScript node and renderer checks passed.
- Production desktop bundles built with the integrated settings section,
  preload API and copied host assets.
- Android 0.3.0-alpha.1 debug APK built; apksigner verified v2/v3 signatures.
  Instrumentation entry points are excluded from the normal APK.
- Even G2: 47 tests passed; its access and pairing implementation is unchanged.
- Source and built-output secret audit passed.
- npm audit found six advisories (five high, one moderate). An audit of the
  unchanged upstream lockfile reports the same six dependency names; no
  dependency-security remediation is claimed by this feature port.

The general upstream suite initially exposed a path-handling bug in existing
hook tests when the checkout path contains spaces (URL `.pathname` retains
`%20`). The affected hook tests passed through a temporary path without spaces
using Node's `--preserve-symlinks` and `--preserve-symlinks-main`. The final full
run used a real source copy without spaces and removed inherited agent-capability
environment variables. This port does not change unrelated hook handling.

The Android HTML/CSS/JS/font assets are byte-identical to the accepted prototype.
The new normal APK omits instrumentation and carries the alpha version:
SHA-256 `509e44e12d0be251db6ed323e03035a0e2d16897c519a439679e8533ff5934fb`.
It has not replaced the installed APK.

A macOS directory package reached ASAR creation; inspection found the host assets,
bonjour-service and secure-remote-password and no acceptance instrumentation.
Final ad-hoc signing failed with a local “internal error in Code Signing
subsystem”. No signing certificate/keychain access was requested. This is not a
successfully signed distributable. The standalone hidden Electron smoke also
failed to start to completion in this environment (timeout with no script output),
including an attempt from a disposable unprotected directory. Its runtime result
is **unverified**; the installed prototype remains the only user-accepted runtime.

## Required release acceptance

Real packaged-build acceptance for this source port remains pending. CI and
synthetic fixtures do not prove GPU capture, Android IME, TalkBack, rotation,
host firewalls or real device input on Windows/Linux. Official desktop release
signing, store distribution and a 30 FPS guarantee are outside this alpha.

The `CanvasLink alpha` workflow runs the contracts and builds a downloadable
development APK. Its CI signature is ephemeral; it is not an update channel.
Run `node scripts/smoke-canvaslink.mjs` after the desktop build to exercise real
Electron preload/IPC and host enable/revoke/disable against a disposable hidden
fixture. It does not send input to user terminals or provide video acceptance.

## Community APK distribution and onboarding (2026-10-26)

- [CanvasLink](https://github.com/teo-nex/CanvasLink) is a separate public
  distribution repository; application source remains in this PR.
- Version `0.3.0-alpha.1` is the APK from successful CI run `40235936427`, source
  commit `eba7baf1f3db716b6600a605f1fda07c39e9119f`, re-signed locally with a
  persistent distribution key. All ZIP entries outside `META-INF` match the CI
  input byte for byte. Normal APKs contain no acceptance instrumentation.
- Distribution APK SHA-256:
  `0534857896b2e22d7e832a8aaa6146b3fc6acb19f3df857cc9d3e8c1caf5a760`.
  Public signing certificate SHA-256:
  `0235b1aee591e4f0e24e59484927ead112889521a1b92e40959076d03635b3cb`.
  The private key and password remain outside both repositories.
- Settings can copy a bilingual, pinned installation prompt and open the guide.
  Copying does not enable the host, mutate pairing, install an APK or expose the
  pairing code/device name. Three handler tests cover both locales and clipboard
  failure; all passed. They use the repository's React test stand-in, not a live
  desktop clipboard or physical Android device.
- The 103 integration tests, TypeScript checks, production build and source/built
  output secret audit passed again after the settings change.
- The agent prompt selects one ADB device, verifies the APK hash, preserves app
  data and stops on signature/downgrade conflicts. USB debugging and the initial
  Android RSA confirmation belong to the device owner.
- Earlier debug signatures may conflict with the new distribution signature.
  No APK was installed on the accepted tablet and no installed desktop was replaced.
  Publication is distinct from physical acceptance of this exact APK/desktop port.
