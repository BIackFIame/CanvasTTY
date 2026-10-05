import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { createConnection, createServer as createNetServer } from "node:net";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { NetworkPolicyManager, isPublicAddress, validatePolicy } from "../src/main/services/isolation/networkPolicy.ts";
import { seatbeltProfile } from "../src/main/services/isolation/seatbelt.ts";
import { bubblewrapArguments } from "../src/main/services/isolation/bubblewrap.ts";
import { isolationPaths } from "../src/main/services/isolation/isolationPaths.ts";
import { AgentIsolation } from "../src/main/services/isolation/AgentIsolation.ts";

const macSandbox = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec");
// Simulated-Linux fixtures listen on Unix-domain socket paths and model POSIX mount paths; on Windows, Node treats a
// listen path as a named pipe and there is no isolation layer (its refusal is covered by the availability tests).
const posixOnly = { skip: process.platform === "win32" ? "simulated Linux isolation needs Unix-domain sockets and POSIX paths" : false };

async function listen(server, ...args) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(...args, () => { server.off("error", reject); resolve(); });
  });
  return server.address();
}

function emptyIsolationPaths() {
  return {
    writable: [], writableFiles: [], creatableFolders: [], protectedWrites: [], protectedDirectories: [],
    gitHooks: [], projectRoots: [], unreadable: [], readableAgain: [], socketFolders: [], socketPrefixes: []
  };
}

function policyManager(t, { platform = process.platform, ...options } = {}) {
  const base = mkdtempSync(join(tmpdir(), "ctty-network-test-"));
  const userDataPath = join(base, "user-data");
  mkdirSync(userDataPath);
  const rootOptions = { userDataPath, platform, ...(platform === "linux" ? { tempRoot: realpathSync("/tmp") } : {}), ...options };
  const manager = new NetworkPolicyManager(rootOptions);
  t.after(async () => { await manager.close(); rmSync(base, { recursive: true, force: true }); });
  return { manager, base, userDataPath };
}

function connectThroughProxy(launch, hostname, port = 443, token = launch.token, trackSocket = () => {}) {
  return new Promise((resolve, reject) => {
    const requestOptions = launch.unixProxyPath
      ? { socketPath: launch.unixProxyPath, method: "CONNECT", path: `${hostname}:${port}` }
      : { host: "127.0.0.1", port: launch.macProxyPort, method: "CONNECT", path: `${hostname}:${port}` };
    const request = httpRequest({
      ...requestOptions,
      headers: token ? { "proxy-authorization": `Basic ${Buffer.from(`canvastty:${token}`).toString("base64")}` } : {}
    });
    request.setTimeout(5_000, () => request.destroy(new Error("Proxy request timed out")));
    request.once("connect", (response, socket, head) => {
      trackSocket(socket);
      resolve({ status: response.statusCode, socket, head });
    });
    request.once("response", (response) => {
      response.resume();
      response.once("end", () => resolve({ status: response.statusCode, socket: null, head: Buffer.alloc(0) }));
    });
    request.once("error", reject);
    request.end();
  });
}

function httpThroughProxy(launch, url) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      ...(launch.unixProxyPath ? { socketPath: launch.unixProxyPath } : { host: "127.0.0.1", port: launch.macProxyPort }),
      path: url,
      headers: { "proxy-authorization": `Basic ${Buffer.from(`canvastty:${launch.token}`).toString("base64")}` }
    }, response => { response.resume(); response.once("end", () => resolve(response.statusCode)); });
    request.setTimeout(5_000, () => request.destroy(new Error("Proxy request timed out")));
    request.once("error", reject);
    request.end();
  });
}

test("network policy persists safe global and per-project choices and rejects malformed domains", (t) => {
  const { manager, base } = policyManager(t);
  const project = join(base, "project");
  mkdirSync(project);
  assert.deepEqual(manager.getPolicy(project), { mode: "open", providerApis: true, packageRegistries: true, domains: [] });
  const saved = manager.setPolicy({ mode: "allowed-domains", domains: ["API.Example.com.", "*.build.example"] }, project);
  assert.deepEqual(saved, { mode: "allowed-domains", providerApis: true, packageRegistries: true, domains: ["*.build.example", "api.example.com"] });
  assert.equal(manager.getPolicy().mode, "open", "the project override does not change global policy");
  assert.equal(manager.getPolicy(project).domains.length, 2);
  assert.deepEqual(manager.setProjectPolicy(project, null), manager.getGlobalPolicy(), "removing an override inherits global policy");
  assert.throws(() => validatePolicy({ mode: "allowed-domains", domains: ["https://example.com"], providerApis: true, packageRegistries: true }), /Invalid network domain/u);
  assert.throws(() => validatePolicy({ mode: "allowed-domains", domains: ["*.com"], providerApis: true, packageRegistries: true }), /too broad/u);
  assert.equal(isPublicAddress("8.8.8.8"), true);
  for (const address of ["127.0.0.1", "10.0.0.8", "100.64.1.2", "169.254.1.2", "172.20.0.1", "192.168.1.1", "::1", "fc00::1", "2001:db8::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
});

test("the default package registry set does not grant the whole Google Cloud Storage host", (t) => {
  const { manager, base } = policyManager(t);
  const project = join(base, "registry-project");
  mkdirSync(project);
  manager.setProjectPolicy(project, { mode: "allowed-domains", providerApis: false, packageRegistries: true, domains: [] });
  const domains = manager.getEffectivePolicy(project, "codex").domains;
  assert.ok(domains.includes("registry.npmjs.org"), "normal package registries remain enabled by default");
  assert.ok(domains.includes("proxy.golang.org"), "the explicit Go module registry remains enabled");
  assert.ok(!domains.includes("storage.googleapis.com"), "the shared storage host is not a default package registry grant");
});

test("network policy cache does not hide a malformed saved document on first read", (t) => {
  const { manager, userDataPath } = policyManager(t);
  writeFileSync(join(userDataPath, "agent-network-policy.json"), "{ invalid json", { mode: 0o600 });
  assert.throws(() => manager.getPolicy(), /invalid JSON/u, "invalid persisted policy still fails closed");
});

test("allowlist proxy authenticates each launch, enforces domains, and pins DNS before connecting", posixOnly, async (t) => {
  let resolved = "93.184.216.34";
  let dialed = null;
  let targetSocket;
  const clientSockets = new Set();
  const upstreamSockets = new Set();
  const trackSocket = (sockets) => (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    t.after(() => socket.destroy());
  };
  const { manager, base } = policyManager(t, {
    platform: "linux",
    resolveAddress: async () => { if (resolved instanceof Error) throw resolved; return resolved; },
    openConnection: (address, port) => {
      dialed = { address, port };
      return createConnection({ path: targetSocket });
    }
  });
  targetSocket = join(base, "target.sock");
  const targetServer = createNetServer((socket) => {
    trackSocket(upstreamSockets)(socket);
    socket.pipe(socket);
  });
  await listen(targetServer, targetSocket);
  t.after(() => targetServer.close());
  const project = join(base, "project");
  const otherProject = join(base, "other-project");
  mkdirSync(project);
  mkdirSync(otherProject);
  manager.setProjectPolicy(project, { mode: "allowed-domains", providerApis: false, packageRegistries: false, domains: ["allowed.example"] });
  manager.setProjectPolicy(otherProject, { mode: "allowed-domains", providerApis: false, packageRegistries: false, domains: ["other.example"] });
  await manager.start();
  const launch = manager.prepareLaunch(project, "codex");
  const otherLaunch = manager.prepareLaunch(otherProject, "codex");
  t.after(() => launch.cleanup());
  t.after(() => otherLaunch.cleanup());

  try {
    assert.equal((await connectThroughProxy(launch, "blocked.example", 443, launch.token, trackSocket(clientSockets))).status, 403);
    assert.equal(dialed, null, "a hostname outside the user allowlist never reaches DNS or the connector");
    assert.equal((await connectThroughProxy(launch, "allowed.example", 443, "wrong-token", trackSocket(clientSockets))).status, 407);
    assert.equal(dialed, null, "another launch's token is required");
    assert.equal((await connectThroughProxy(launch, "allowed.example", 443, otherLaunch.token, trackSocket(clientSockets))).status, 403,
      "another launch's valid token stays bound to that launch's domain grant");
    assert.equal(dialed, null, "the foreign launch's domain grant does not reach the connector");
    const otherAllowed = await connectThroughProxy(otherLaunch, "other.example", 443, otherLaunch.token, trackSocket(clientSockets));
    assert.equal(otherAllowed.status, 200, "valid tokens later in the live-grant scan still authenticate");
    otherAllowed.socket.destroy();

    for (const url of ["http://127.0.0.1/", "http://[::1]/", "http://10.0.0.1/"]) {
      assert.equal(await httpThroughProxy(launch, url), 403, "authenticated IP-literal requests are denied without crashing the host");
    }
    resolved = new Error("fixture DNS failure");
    assert.equal(await httpThroughProxy(launch, "http://allowed.example/"), 502, "unexpected forwarding failures affect only this request");
    resolved = "93.184.216.34";

    const allowed = await connectThroughProxy(launch, "allowed.example", 443, launch.token, trackSocket(clientSockets));
    assert.equal(allowed.status, 200);
    assert.deepEqual(dialed, { address: "93.184.216.34", port: 443 }, "the proxy dials the DNS-pinned public IP literal");
    allowed.socket.write("pinned-connection");
    const echoed = await new Promise((resolve, reject) => {
      allowed.socket.once("data", (data) => { allowed.socket.destroy(); resolve(data.toString()); });
      allowed.socket.once("error", reject);
    });
    assert.equal(echoed, "pinned-connection");

    resolved = "127.0.0.1";
    dialed = null;
    assert.equal((await connectThroughProxy(launch, "allowed.example", 443, launch.token, trackSocket(clientSockets))).status, 403, "DNS rebinding to loopback is refused");
    assert.equal(dialed, null);
  } finally {
    for (const socket of clientSockets) socket.destroy();
    for (const socket of upstreamSockets) socket.destroy();
    clientSockets.clear();
    upstreamSockets.clear();
  }
});

test("Linux network arguments create a private network namespace and expose only the Unix proxy socket", () => {
  const paths = emptyIsolationPaths();
  const socket = "/tmp/ctty-proxy-test.sock";
  const args = bubblewrapArguments(paths, {
    command: "/helpers/canvastty-helper", args: ["network-bridge"], cwd: "/project",
    network: { mode: "allowed-domains", proxySocketPath: socket }
  }, (path) => path === socket ? "socket" : null);
  assert.ok(args.includes("--unshare-net"));
  assert.ok(args.includes("--ro-bind"));
  assert.ok(args.includes(socket));
  assert.equal(args.includes("--share-net"), false);
  assert.throws(() => bubblewrapArguments(paths, {
    command: "/bin/sh", args: [], cwd: "/project", network: { mode: "allowed-domains", proxySocketPath: socket }
  }, () => null), /proxy socket is missing/u);
  const offline = bubblewrapArguments(paths, { command: "/bin/sh", args: [], cwd: "/project", network: { mode: "offline" } }, () => null);
  assert.ok(offline.includes("--unshare-net"));
});

test("strict network isolation hides the host browser socket directory and drops broad temp socket grants", posixOnly, (t) => {
  const { base, userDataPath } = policyManager(t);
  const project = join(base, "project");
  const home = join(base, "home");
  const temp = join(base, "ctty-iso-launch", "tmp");
  const browserRuntime = join(userDataPath, "browser", "runtime");
  mkdirSync(project);
  mkdirSync(home);
  mkdirSync(temp, { recursive: true });
  mkdirSync(browserRuntime, { recursive: true });
  const paths = isolationPaths({
    provider: "codex", cwd: project, sessionTemp: temp,
    env: {
      HOME: home,
      CANVASTTY_AGENT_BROWSER_ADDRESS: join(browserRuntime, "gateway.sock"),
      CANVASTTY_ORCHESTRATION_ADDRESS: join(userDataPath, "orchestration", "runtime", "orchestration.sock")
    },
    userDataPath, sessionId: "strict-socket-test", networkMode: "offline"
  });

  const systemDaemonSockets = [
    "/run/docker.sock", "/run/dbus/system_bus_socket", "/run/containerd/containerd.sock", "/run/podman/podman.sock"
  ];
  for (const socket of systemDaemonSockets) {
    assert.ok(paths.unreadable.includes(socket), `strict mode marks ${socket} for masking`);
  }

  assert.ok(paths.unreadable.some((path) => path.endsWith("/browser/runtime")), "Linux overlays the browser socket directory with tmpfs");
  assert.equal(paths.socketFolders.some((path) => path.includes("/browser/runtime")), false);
  assert.equal(paths.socketPrefixes.length, 0, "strict mode does not allow arbitrary ctty-* sockets under /tmp");
  assert.ok(paths.socketFolders.some((path) => path.includes("/orchestration/runtime")), "essential orchestration stays available");

  const args = bubblewrapArguments(paths, {
    command: "/bin/true", args: [], cwd: project, network: { mode: "offline" }
  }, (path) => path === browserRuntime ? "directory" : systemDaemonSockets.includes(path) ? "socket" : null);
  assert.ok(args.includes("--tmpfs"));
  assert.ok(args.includes(browserRuntime), "the mounted tmpfs covers the host browser gateway directory");
  for (const socket of systemDaemonSockets) {
    assert.ok(args.some((arg, index) => arg === "--ro-bind" && args[index + 1] === "/dev/null" && args[index + 2] === socket),
      `strict bubblewrap mounts a neutral file over ${socket}`);
  }
  const profile = seatbeltProfile(paths, { mode: "offline" });
  assert.match(profile, /\(deny network-inbound \(local ip\)\)/u, "strict mode refuses inbound IP listeners");
  assert.doesNotMatch(profile, /allow network-outbound[^\n]*mDNSResponder/u, "strict mode has no unrestricted DNS socket exception");
  assert.doesNotMatch(profile, /allow network-outbound \(remote unix-socket \(subpath [^\n]*browser\/runtime/u);
});

test("strict network policy follows the project root and refuses when its OS layer is off or unavailable", (t) => {
  const { manager, base } = policyManager(t);
  const project = join(base, "project");
  const other = join(base, "other");
  mkdirSync(project);
  mkdirSync(other);
  manager.setGlobalPolicy({ mode: "open", domains: [] });
  manager.setProjectPolicy(project, { mode: "offline", domains: [] });
  const on = new AgentIsolation({ userDataPath: join(base, "user-data"), networkPolicy: manager, enabled: () => true, platform: "darwin", exists: () => true });
  assert.equal(on.decide({ provider: "codex", profile: "normal", delegated: false, cwd: project }).apply, true,
    "strict project policy wraps even a human normal launch");
  assert.equal(on.decide({ provider: "codex", profile: "normal", delegated: false, cwd: other }).apply, false,
    "a different project inherits the open global policy");
  const off = new AgentIsolation({ userDataPath: join(base, "user-data"), networkPolicy: manager, enabled: () => false, platform: "darwin", exists: () => true });
  assert.match(off.decide({ provider: "codex", profile: "normal", delegated: true, cwd: project }).refuse, /requires agent isolation to be on/u);
  const windows = new AgentIsolation({ userDataPath: join(base, "user-data"), networkPolicy: manager, enabled: () => true, platform: "win32" });
  assert.match(windows.decide({ provider: "codex", profile: "normal", delegated: true, cwd: project }).refuse, /cannot be enforced/u);
  assert.match(on.decide({ provider: "codex", profile: "normal", delegated: true, cwd: project, environment: { isolated: true, label: "Remote box" } }).refuse, /inside Remote box/u);
  let failure = "Landlock ABI 9 is required (kernel provides ABI 8)";
  let checks = 0;
  let now = 0;
  const linux = new AgentIsolation({ userDataPath: join(base, "user-data"), networkPolicy: manager, enabled: () => true,
    platform: "linux", bubblewrapPath: "/fake/bwrap", bubblewrapProbe: () => null, networkHelperPath: "/fake/helper",
    networkIsolationProbe: () => { checks++; return failure; }, now: () => now });
  const input = { provider: "codex", profile: "normal", delegated: false, cwd: project };
  assert.match(linux.decide(input).refuse, /Landlock ABI 9/u, "an older kernel cannot silently leave host sockets reachable");
  failure = null;
  assert.match(linux.decide(input).refuse, /Landlock ABI 9/u, "failed probes are bounded instead of running on each launch");
  now = 60_001;
  assert.equal(linux.decide(input).apply, true, "enabling the kernel boundary recovers without restarting CanvasTTY");
  assert.equal(checks, 2);
  const missing = new AgentIsolation({ userDataPath: join(base, "user-data"), networkPolicy: manager, enabled: () => true,
    platform: "linux", bubblewrapPath: "/fake/bwrap", bubblewrapProbe: () => null });
  assert.match(missing.decide(input).refuse, /native Unix socket guard is missing/u);
  assert.equal(missing.decide({ ...input, cwd: other }).apply, false, "open manual launches need no native socket guard");
});

test("both strict Linux launches guard exact core sockets and release resources when the guard refuses", posixOnly, async (t) => {
  const { base, userDataPath } = policyManager(t);
  const project = join(base, "project");
  const home = join(base, "home");
  const tempRoot = join(base, "temp");
  for (const path of [project, home, tempRoot]) mkdirSync(path);
  const proxy = join(base, "proxy.sock");
  const server = createNetServer((socket) => socket.end());
  await listen(server, proxy);
  t.after(() => server.close());
  let mode = "offline";
  let released = 0;
  const networkPolicy = {
    getPolicy: () => ({ mode }), availability: () => ({ available: true }),
    prepareLaunch: () => ({ mode, domains: [], ...(mode === "allowed-domains" ? { unixProxyPath: proxy, token: "a".repeat(64) } : {}), cleanup() { released++; } })
  };
  const options = { userDataPath, networkPolicy, enabled: () => true, tempRoot, platform: "linux", hostEnvironment: { HOME: home },
    bubblewrapPath: "/fake/bwrap", bubblewrapProbe: () => null, networkHelperPath: "/bin/true", networkIsolationProbe: () => null,
    linuxHostPaths: { prepare: () => () => {} } };
  const launch = { sessionId: "linux-network", provider: "codex", cwd: project, command: "/bin/sh", args: ["-c", "true"],
    env: { HOME: home, CANVASTTY_RUNTIME_ADDRESS: join(base, "runtime.sock"), CANVASTTY_ORCHESTRATION_ADDRESS: join(base, "orchestration.sock"),
      CANVASTTY_OTHER_ADDRESS: join(base, "untrusted.sock"), HTTP_PROXY: "http://untrusted.invalid", no_proxy: "*" } };
  for (mode of ["offline", "allowed-domains"]) {
    const wrapped = new AgentIsolation(options).wrap(launch);
    try {
      const at = wrapped.args.indexOf("network-bridge");
      assert.equal(wrapped.args[at - 1], options.networkHelperPath);
      const expected = ["network-bridge", ...(mode === "offline" ? ["--offline"] : ["--socket", proxy, "--token", "a".repeat(64)]),
        "--allow-socket", launch.env.CANVASTTY_RUNTIME_ADDRESS, "--allow-socket", launch.env.CANVASTTY_ORCHESTRATION_ADDRESS,
        "--", launch.command, ...launch.args];
      assert.deepEqual(wrapped.args.slice(at), expected, "only core-selected exact socket addresses become kernel grants");
      assert.ok(wrapped.args.includes("--unshare-net"));
      assert.ok(wrapped.args.some((arg, index) => arg === "--ro-bind" && wrapped.args[index + 1] === base && wrapped.args[index + 2] === base),
        "host gateway directories stay read-only, so their approved endpoints cannot be replaced");
      assert.equal(wrapped.env.HTTP_PROXY, undefined);
      assert.equal(wrapped.env.no_proxy, undefined);
    } finally { wrapped.cleanup(); }
  }
  assert.equal(released, 2);
  const refusing = new AgentIsolation({ ...options, networkIsolationProbe: () => "Landlock ABI 9 is unavailable" });
  assert.throws(() => refusing.wrap(launch), /Landlock ABI 9 is unavailable/u, "wrap also refuses when callers skip decide");
  assert.equal(released, 3, "the failed launch revokes its prepared network capability");
});

test("macOS isolated launch injects the authenticated proxy and exact allow rule", { skip: macSandbox ? false : "macOS seatbelt only" }, async (t) => {
  const { base, userDataPath } = policyManager(t);
  const project = join(base, "project");
  const tempRoot = join(base, "temp");
  mkdirSync(project);
  mkdirSync(tempRoot);
  const manager = {
    getPolicy: () => ({ mode: "allowed-domains", providerApis: false, packageRegistries: false, domains: ["api.example.com"] }),
    getEffectivePolicy: () => ({ mode: "allowed-domains", domains: ["api.example.com"] }),
    availability: () => ({ available: true }),
    prepareLaunch: () => ({ mode: "allowed-domains", domains: ["api.example.com"], token: "a".repeat(64), macProxyPort: 23456, cleanup() {} })
  };
  const isolation = new AgentIsolation({ userDataPath, networkPolicy: manager, enabled: () => true, tempRoot, platform: "darwin" });
  const wrapped = isolation.wrap({
    sessionId: "mac-network", provider: "codex", cwd: project, networkProjectRoot: project,
    command: "/bin/true", args: [], env: { ...process.env, HTTP_PROXY: "http://untrusted.invalid", no_proxy: "*" }
  });
  t.after(() => wrapped.cleanup());
  assert.match(wrapped.env.HTTP_PROXY, /^http:\/\/canvastty:[a-f0-9]{64}@127\.0\.0\.1:\d+$/u);
  assert.equal(wrapped.env.HTTPS_PROXY, wrapped.env.HTTP_PROXY);
  assert.equal(wrapped.env.NO_PROXY, "127.0.0.1,localhost,::1");
  const port = Number(new URL(wrapped.env.HTTP_PROXY).port);
  const profile = readFileSync(wrapped.args[1], "utf8");
  assert.ok(profile.includes(`(allow network-outbound (remote tcp "localhost:${port}"))`));
  assert.ok(profile.includes("(deny network-outbound (remote ip))"));
});

test("macOS seatbelt allows only the exact proxy/hook ports and blocks direct loopback", { skip: macSandbox ? false : "macOS seatbelt only" }, async (t) => {
  const allowedServer = createNetServer();
  const blockedServer = createNetServer();
  const hookServer = createNetServer();
  const allowed = await listen(allowedServer, 0, "127.0.0.1");
  const blocked = await listen(blockedServer, 0, "127.0.0.1");
  const hook = await listen(hookServer, 0, "127.0.0.1");
  t.after(() => { allowedServer.close(); blockedServer.close(); hookServer.close(); });
  const profile = seatbeltProfile(emptyIsolationPaths(), { mode: "allowed-domains", proxyPort: allowed.port, loopbackPorts: [hook.port] });
  assert.match(profile, new RegExp(`allow network-outbound \\(remote tcp \\"localhost:${allowed.port}\\"\\)`));
  assert.match(profile, new RegExp(`allow network-outbound \\(remote tcp \\"localhost:${hook.port}\\"\\)`));
  assert.match(profile, /deny network-outbound \(remote ip\)/u);
  // A second profile proves the deny has no localhost-wide exception.
  const offline = seatbeltProfile(emptyIsolationPaths(), { mode: "offline" });
  const script = `const net=require('node:net');const ports=process.argv.slice(1).map(Number);Promise.all(ports.map(port=>new Promise(resolve=>{const s=net.createConnection({host:'127.0.0.1',port});s.once('connect',()=>{s.destroy();resolve('connected')});s.once('error',e=>resolve('blocked:'+e.code));setTimeout(()=>{s.destroy();resolve('timeout')},1200)}))).then(x=>console.log(x.join(',')))`;
  const allowedRun = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "-e", script, String(allowed.port), String(blocked.port), String(hook.port)], { encoding: "utf8", timeout: 10_000 });
  assert.equal(allowedRun.status, 0, allowedRun.stderr);
  assert.match(allowedRun.stdout.trim(), /^connected,blocked:.*connected$/u, allowedRun.stdout);
  const offlineRun = spawnSync("/usr/bin/sandbox-exec", ["-p", offline, process.execPath, "-e", script, String(allowed.port), String(hook.port)], { encoding: "utf8", timeout: 10_000 });
  assert.equal(offlineRun.status, 0, offlineRun.stderr);
  assert.match(offlineRun.stdout.trim(), /^blocked:.*blocked:/u, offlineRun.stdout);
  const listenerScript = `const net=require('node:net');const server=net.createServer();server.once('error',error=>{console.log('blocked:'+error.code)});server.listen(0,'127.0.0.1',()=>{console.log('listening');server.close()})`;
  const listenerRun = spawnSync("/usr/bin/sandbox-exec", ["-p", offline, process.execPath, "-e", listenerScript], { encoding: "utf8", timeout: 10_000 });
  assert.equal(listenerRun.status, 0, listenerRun.stderr);
  assert.match(listenerRun.stdout.trim(), /^blocked:(?:EPERM|EACCES)$/u, "strict network mode also refuses a local listener");
});
