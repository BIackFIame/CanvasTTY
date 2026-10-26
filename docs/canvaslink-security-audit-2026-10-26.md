# CanvasLink: bounded security and failure-path audit

Reviewed on 2026-10-26, starting at `f643b31c476e490904437c95c13f0db33ad7c310`.
This report covers the embedded host, Android transport/direct-input assets,
pairing/channel implementation, IPC ownership and installation contract. It is
not a penetration-test certification or acceptance of an installed release.

## Confirmed findings and fixes

Severity below is a local assessment of the demonstrated behavior, not a CVSS score.

| Finding | Preconditions and impact | Fix and regression evidence |
| --- | --- | --- |
| Medium: session expiry did not revoke an established video peer | An already paired client could stop polling and keep receiving video after the advertised 12-hour session lifetime. Request/input checks rejected expired credentials, but no passive expiry path stopped media. This did not bypass the PIN. | `Pairing.expire()` removes credentials before invoking revocation; requests and outgoing signals invoke it, and the host invokes it every 200 ms independently of client traffic and UI health polling. Tests cover the exact expiry boundary, one-time revocation, silent clients and rejected expired requests/queues. Timer delivery still depends on the Electron main event loop. |
| Medium: revocation waited for an asynchronous UI refresh | A stalled or rejected settings-state read delayed or prevented closing a live peer after a valid revoke event. | The capture worker closes tracks, peer and input ownership synchronously before refreshing its UI. A deferred/rejected refresh test proves media and control stop first. |
| Low: delayed signalling could undo client suspension/disconnect | In-flight offers could create a new peer while hidden or locally disconnected. A delayed native pairing callback could also re-arm the client after explicit disconnect. These were stale messages from an existing authenticated connection, not unauthenticated remote pairing. | Ignore offers/disconnect signals unless paired and visible; ignore pairing completions after explicit disconnect until a new connect request. Tests cover unpaired, hidden and disconnected clients, delayed pairing completion and negotiation completion after disconnect. |
| Reliability: stale SDP failure overwrote current connection state | Failure of a superseded offer could mark a healthy new connection as failed. | Peer generations and checks after asynchronous SDP steps isolate stale completion/errors. |
| Reliability: buffered pointer motion survived session close | A queued animation-frame callback could submit old pointer movement to the next connection. | Close discards buffered movement and cancels its frame callback. No clicks, text or keys are replayed. |
| Input safety: one-shot Ctrl leaked through other commits | A Unicode/multi-character IME commit or native key could leave Ctrl armed, turning the next letter into an unexpected shortcut such as Ctrl+C. | Consume Ctrl on each committed text/key event. Browser fixture covers Cyrillic, emoji, multi-character text and native arrow input. |

Before fixes, the new regressions failed in seven cases in the first targeted
run and two further cases in the revocation-focused run. These were application
failures. A separate HTTP fixture initially lacked Node's `Buffer` global; that
test-harness error was corrected and is not an application finding.

## Boundaries exercised

- Real SRP mutual authentication and AES-GCM request/response code, using
  synthetic keys and messages. Wrong PIN, used/expired code, attempt limits,
  wrong address, tampering, reflection and replay are rejected.
- The actual HTTP request handler, driven by in-memory Node request streams:
  public source addresses, browser origins (including `null`), unsupported
  routes/methods, non-JSON content types, invalid JSON and oversized bodies are
  rejected. An authenticated signal reaches the renderer once; a forged,
  replayed, unsupported or revoked signal does not.
- IPC owner/main-frame checks and serialized settings operations, including a
  window closing while a command waits. Capture is scoped to the owned window;
  no global input injector or shell execution was added.
- Android navigation/resource allowlists, disabled file/content access, denied
  WebView media permissions and encrypted app-private session storage were
  inspected. Those native boundaries were not penetration-tested on hardware.
- Installation remains pinned to the published APK hash/certificate and stops
  on signing conflicts. No private signing files or pairing credentials were
  copied into the source tree or report.

## Verification of this patch

- **115/115 CanvasLink tests passed**, no skips; 12 tests added to the previous 103.
- **3/3 desktop installation-prompt tests passed**.
- TypeScript checks, production desktop bundles and the source/built-output
  secret audit passed.
- The Android development APK compiled with SDK 35 / JDK 17; apksigner verified
  its v2/v3 signatures. This is a local development artifact, not a release APK.
- Tests use simulated WebRTC/Electron objects and browser fixtures; HTTP tests
  do not open a network listener. They prove the demonstrated control flow,
  not real GPU capture or physical input on Windows/Linux/Android.

The installed desktop/tablet and public `0.3.0-alpha.1` APK were not replaced.
The client-side fixes require a subsequent APK build/release; desktop fixes
require a CanvasTTY build containing this patch. No new release is claimed.

## Open dependency issues

Fresh `npm audit --package-lock-only --json` reports **6 vulnerable packages:
5 high, 1 moderate**, matching an audit of the unchanged upstream baseline
`0fa6895d3675b40ec4dc75886826dd2db234c234` with its own manifest/lockfile.
The package names are Electron, Vite, undici, zod, source-map-js and fast-uri.
An installed-tree audit reports 18 affected packages including dependent parent
packages; this is a different audit tree/count, not 12 newly introduced root
advisories. CanvasLink's bonjour/SRP dependencies are not listed by these audits.

`npm audit --omit=dev` reports zero, but that **does not establish runtime safety**:
Electron is declared as a development dependency and is shipped in the desktop.
Its pinned version here is 43.7.7. The maintainer's
[Electron advisory](https://github.com/electron/electron/security/advisories/GHSA-jr5w-w6x2-84p9)
describes compromised intermediate TLS certificates; 43.8.1 contains the fix
for this release line. Exploitation requires intercepted TLS traffic and a
relevant certificate. This audit did not demonstrate exploitation in CanvasTTY.
Vite's
[file-serving advisory](https://github.com/vitejs/vite/security/advisories/GHSA-rq7h-c2jc-7f22)
requires an exposed development server and additional path/import conditions;
it is not evidence that CanvasLink's separate JSON listener serves files.

Dependency updates and their desktop/native packaging validation remain open;
this patch does not silently change the upstream Electron/build toolchain.

## Remaining acceptance and review gaps

- Physical source-port acceptance on macOS, Windows, Linux and Android remains
  pending. Prior prototype acceptance is not acceptance of this patch or APK.
- Native Android logout clears persisted credentials only after its queued
  network revoke attempt. Abrupt process death during an offline logout and
  pairing/restore cancellation need a native lifecycle regression and follow-up;
  the JavaScript disconnect guard does not prove durable native logout.
- No independent cryptographic review of the SRP implementation or WebRTC stack
  was performed. Passing protocol tests is not such a review.
- A paired device controls the entire owned CanvasTTY window, including its
  terminals and settings. Pairing is a broad trust grant, not terminal sandboxing.
  LAN/source-address checks do not protect against a compromised paired device.
- No claim of denial-of-service resistance under adversarial LAN load,
  dependency remediation, zero vulnerabilities or release readiness is made.
