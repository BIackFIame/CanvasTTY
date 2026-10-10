# macOS PTY descriptor ownership

CanvasTTY pins `node-pty` 1.1.0 and carries the reproducible MIT-licensed source
patch in `patches/node-pty+1.1.0.patch`. This avoids adopting an unrelated
prerelease dependency to fix a macOS resource bug.

## Cause and patch scope

The original macOS `pty_posix_spawn` opens temporary PTY masters to reserve
closed standard descriptors. With ordinary open stdio, its first reservation
gets an FD above 2 and exits the loop with `count == 0`. Cleanup consequently
skips that reservation. The other counter values also skip element zero and can
address past the array after allocation failures. Child spawn file-actions do
not close the parent's slave descriptor. Early errors leave partially acquired
resources behind, and the exit watcher separately retains its private kqueue.

The upstream ownership fixes are documented in
[node-pty #882](https://github.com/microsoft/node-pty/pull/882) and
[node-pty #931](https://github.com/microsoft/node-pty/pull/931).
This backport uses scoped ownership for every temporary FD and for initialized
spawn objects. Only a successfully spawned master's ownership is transferred to
the caller; failed reservations, grant/unlock, slave setup, file-actions, attrs
and native spawn all unwind through the same cleanup. Grant and unlock failures
are checked individually. The exit kqueue is closed before its exit callback.
Nonblocking setup failures also close the descriptors acquired by that call;
a spawned child without an installed exit callback is stopped and reaped.

The patch preserves the upstream copyright/license and does not change the
successful public API. Linux/Windows spawning does not use the macOS reservation
algorithm.

## Build and distribution

`npm ci` invokes the root `postinstall`: `patch-package --error-on-fail` runs
before a forced `electron-rebuild --build-from-source`. A failed source patch or
rebuild fails installation rather than silently continuing with a pristine
native binary. The dependency version and lockfile remain pinned; review/update
the patch deliberately when adopting a verified upstream fix.

Packaging retains `npmRebuild: true`, forces `buildDependenciesFromSource`,
unpacks node-pty's runtime/native files and excludes pristine Darwin prebuilds.
The macOS smoke requires the actual `build/Release` addon and executable
`spawn-helper`, including in the separately packaged application. Skipping
installation scripts skips this installation contract; run `npm run postinstall`
before using such a developer checkout.

## Verification

The safe cross-host check is:

```sh
node --test tests/node-pty-patch.test.mjs
```

Its C++ harness compiles the dependency's actual patched macOS function, with
allocation/spawn syscalls redirected to a descriptor ledger. It checks success,
each injected error, EINTR retry, every combination of closed stdio, foreign FD
preservation, initialized-object destruction and repeated cleanup. No real PTY
is allocated by this unit test. The original source fails the ownership check.

The real-OS checks run ONLY in the isolated macOS GitHub Actions workflow
`.github/workflows/pty-resources.yml`, never on a user's working desktop:

- Rebuild unpatched 1.1.0 for Electron and stop the control run at its first
  measured extra-master leak (at most six measured cycles).
- Apply the tracked patch and rebuild for Electron.
- Run 400 sequential create/exit/stop cycles in ONE persistent Electron parent,
  with at most one live PTY; abort immediately on descriptor growth.
- Exercise native `posix_spawn` failure with oversized argv, then create a new
  PTY to demonstrate the failure did not exhaust or poison the parent.
- Check all seven nonempty combinations of closed standard descriptors.
- Package a new macOS application, verify its signature and repeat the checks
  using that application's actual native addon, not the development module.

Every run records real FD counts before/after and `peakSettled` counts (the
maximum residual count after each completed cycle, not the live-phase peak). PTY masters,
slave/revoked devices and kqueues have zero leak allowance. The total allows a
symmetric difference in counts of two ordinary FDs for lsof/Node pipe-finalization timing,
with bounded settling. A failed/empty census is an error, never a zero count.
Only synthetic CI evidence and the separate test build are retained as Actions
artifacts. No personal application state, terminal buffers, credentials or
local diagnosis logs are included.

## Applying a fix is not recovering an existing process

This change does not modify an installed application or hot-replace a loaded
native library. Existing leaked reservations/slaves/kqueues are not tracked by
node-pty's public PTY handles, nor exposed by CanvasTTY's owned-session control
API. Closing a known terminal closes its tracked master; it does not identify
or safely release arbitrary orphaned FDs. Replacing an on-disk addon also does
not replace code already loaded by Electron.

There is no supported recovery operation here that preserves the existing
process and all user terminals. Do not inject code, close guessed descriptors,
raise kernel limits or stop unrelated sessions. Applying the separately built
fix and reclaiming an old process's leaks requires an owner-approved graceful
quit/relaunch. Review saved session/conversation restoration first: saved tabs
are not the same as still-running PTY processes. That operational restart is a
separate task, not part of this source fix or CI build.
