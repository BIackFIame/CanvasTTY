// Micro-benchmarks for the main-process hot paths, run by scripts/bench-runtime.mjs in a plain Node process
// (`--experimental-strip-types`, the sources are imported as they are). Every scenario uses only public
// entry points that exist before and after the performance work, so the same file measures both.
// Prints one JSON object on stdout.
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { Session } from "node:inspector/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(process.argv[2] ?? ".");
const load = (path) => import(pathToFileURL(join(ROOT, path)).href);
const { TerminalManager } = await load("src/main/services/TerminalManager.ts");
const { AgentControlService } = await load("src/main/services/AgentControlService.ts");
const { SecretRedactionRegistry } = await load("src/main/services/safety/SecretRedaction.ts");
const { TerminalPresentation } = await load("src/main/services/companion/TerminalPresentation.ts");
const { ProviderLaunchAdapters } = await load("src/main/services/agent-browser/ProviderLaunch.ts");

const SCROLLBACK = 240_000;
const inspector = new Session();
inspector.connect();
await inspector.post("HeapProfiler.enable");

/** Bytes allocated while fn runs, garbage included (sampled every 1 KiB). */
async function allocated(fn) {
  await inspector.post("HeapProfiler.startSampling", {
    samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true
  });
  await fn();
  const { profile } = await inspector.post("HeapProfiler.stopSampling");
  let total = 0;
  const walk = (node) => { total += node.selfSize; node.children.forEach(walk); };
  walk(profile.head);
  return total;
}

function timed(fn, iterations) {
  fn();
  const start = performance.now();
  for (let i = 0; i < iterations; i++) fn();
  return (performance.now() - start) / iterations;
}

const clis = {
  get: (provider) => ({ state: "available", provider, executable: `/resolved/${provider}`, launcher: "native", environment: {}, checked: [] }),
  snapshot: () => ({})
};

/** A TerminalManager on fake PTYs; `print(id, text)` is what the PTY would have written. */
function manager(emit = () => undefined) {
  const writers = new Map();
  let pending = null;
  const terminals = new TerminalManager(emit, clis, undefined, undefined, true, () => {
    const pty = { pid: 1, write() {}, resize() {}, kill() {},
      onData(listener) { pending = listener; return { dispose() {} }; },
      onExit() { return { dispose() {} }; } };
    return pty;
  });
  const create = (request) => {
    const session = terminals.create({ profile: "normal", cwd: tmpdir(), position: { x: 0, y: 0 }, ...request });
    writers.set(session.id, pending);
    return session;
  };
  return { terminals, create, print: (id, text) => writers.get(id)(text) };
}

// A line of ordinary agent output (colour, paths, numbers), no secrets.
const line = (i) => `\x1b[32m✓\x1b[0m step ${i} src/main/services/Example.ts:${i} finished in ${i % 97} ms — value = compute(${i}, "ok")\r\n`;
function fill(print, id, chars, chunk = 4096) {
  let text = "";
  let i = 0;
  while (text.length < chars) text += line(i++);
  for (let offset = 0; offset < text.length; offset += chunk) print(id, text.slice(offset, offset + chunk));
}

const results = {};

// (a) Scrollback retention: characters still referenced by the chunk array after 2 MB of output.
{
  results.scrollbackRetainedChars = {};
  for (const chunk of [1024, 4096, 16384]) {
    const f = manager();
    const session = f.create({ provider: "terminal" });
    fill(f.print, session.id, 2_000_000, chunk);
    const managed = f.terminals.sessions.get(session.id);
    const retained = managed.bufferChunks.reduce((sum, part) => sum + (typeof part === "string" ? part.length : 0), 0);
    results.scrollbackRetainedChars[`chunk${chunk}`] = retained;
    await f.terminals.shutdown();
  }
}

// (b) Bytes sent to the renderer when 8 hidden cards (full 240K scrollback each) become visible after 1 KB more output.
{
  let rendererBytes = 0;
  let counting = false;
  const f = manager((channel, payload) => {
    if (counting && channel === "terminal:data" && payload.audience !== "observers") rendererBytes += payload.data.length;
  });
  const ids = [];
  for (let i = 0; i < 8; i++) {
    const session = f.create({ provider: "terminal" });
    ids.push(session.id);
    fill(f.print, session.id, SCROLLBACK + 10_000);
  }
  for (const id of ids) f.terminals.setVisible(id, false);
  for (const id of ids) f.print(id, "x".repeat(1024));
  counting = true;
  for (const id of ids) f.terminals.setVisible(id, true);
  counting = false;
  results.visibleResendBytes8Cards = rendererBytes;
  await f.terminals.shutdown();
}

// (c)+(d) One orchestrator tool call on a canvas of 20 agent cards with full scrollback:
// the ownership check, status lookup and observe_agent (redaction included).
{
  const f = manager();
  const orchestrator = f.create({ provider: "claude", role: "orchestrator" });
  const children = [];
  for (let i = 0; i < 19; i++) {
    const child = f.create({ provider: "claude", role: "subagent", parentSessionId: orchestrator.id });
    children.push(child.id);
  }
  for (const id of [orchestrator.id, ...children]) fill(f.print, id, SCROLLBACK + 10_000);
  const registry = new SecretRedactionRegistry();
  registry.add("vault", ["purple-otter-marmalade-sings-loudly-7"]);
  f.terminals.configureRedaction(registry);
  const control = new AgentControlService(f.terminals);
  const target = children[7];
  const toolCall = () => {
    control.status(orchestrator.id);
    control.isInSubtree(orchestrator.id, target);
    return control.observe(target).output.length;
  };
  results.orchestratorToolCallMs = Number(timed(toolCall, 20).toFixed(2));
  results.orchestratorToolCallAllocatedBytes = await allocated(() => { for (let i = 0; i < 10; i++) toolCall(); }) / 10;
  results.observeAgentMs = Number(timed(() => control.observe(target), 20).toFixed(2));
  results.listAgentsMs = Number(timed(() => control.children(orchestrator.id), 20).toFixed(2));
  await f.terminals.shutdown();
}

// (j) Even G2 companion on: 8 cards stream 512 KB each, the glasses show one of them.
{
  const sessions = [];
  const buffers = new Map();
  const port = {
    listMetadata: () => sessions.map((id) => ({ id, provider: "terminal", status: "running", title: id })),
    geometry: () => ({ cols: 120, rows: 40 }),
    readBuffer: (id) => ({ buffer: buffers.get(id)?.text ?? "", outputOffset: buffers.get(id)?.text.length ?? 0 })
  };
  const presentation = new TerminalPresentation(port);
  for (let i = 0; i < 8; i++) { sessions.push(`s${i}`); buffers.set(`s${i}`, { text: "" }); }
  await presentation.read("s0");
  let body = "";
  for (let i = 0; i < 1500; i++) body += line(i);
  const start = performance.now();
  for (let offset = 0; offset < 512_000; offset += body.length) {
    for (const id of sessions) {
      const state = buffers.get(id);
      state.text += body;
      presentation.observe("terminal:data", { id, data: body, outputOffset: state.text.length });
    }
  }
  await presentation.read("s0");
  results.evenG2FeedMs = Number((performance.now() - start).toFixed(1));
  results.evenG2HeadlessTerminals = [...presentation.screens.values()].filter((screen) => screen.terminal).length;
  presentation.close();
}

// (e) Main-thread block on the first Kimi launch; the stand-in CLI answers --help after 1 s.
{
  const root = await mkdtemp(join(tmpdir(), "bench-kimi-"));
  const kimi = join(root, "kimi");
  await writeFile(kimi, "#!/bin/sh\nsleep 1\necho '  --mcp-config-file PATH'\n");
  await chmod(kimi, 0o755);
  const adapters = new ProviderLaunchAdapters({
    helper: { command: "/opt/CanvasTTY/helper", args: ["--stdio"] },
    providerClis: { get: (provider) => ({ state: "available", provider, executable: kimi, launcher: "native", environment: {}, checked: [] }), snapshot: () => ({}) },
    kimiHomeDirectory: join(root, "kimi-home"),
    hermesHomeDirectory: join(root, "hermes-home"),
    runtimeDirectory: join(root, "runtime")
  });
  // The app warms the probe in the background when it can (after the fix); the launch comes later.
  if (typeof adapters.warmKimiProbe === "function") await adapters.warmKimiProbe();
  const start = performance.now();
  adapters.prepare("kimi", "bench").releaseConfiguration();
  results.kimiFirstLaunchBlockMs = Math.round(performance.now() - start);
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(results)}\n`);
process.exit(0);
