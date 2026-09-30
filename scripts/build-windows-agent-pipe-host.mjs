#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "node:net";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const nativeRoot = join(repositoryRoot, "native", "windows-agent-pipe-host");
const outputName = "canvastty-windows-agent-pipe-host.exe";
const builtHost = join(nativeRoot, "build", "Release", outputName);
const stagedHost = join(repositoryRoot, "build", "windows-agent-pipe-host", outputName);
const requireWindows = process.argv.includes("--require-windows");
const runSelfTest = process.argv.includes("--self-test");

if (process.platform !== "win32") {
  if (requireWindows) {
    process.stderr.write("The secure named-pipe host must be built on Windows.\n");
    process.exit(1);
  }
  process.exit(0);
}

const nodeGyp = join(repositoryRoot, "node_modules", "node-gyp", "bin", "node-gyp.js");
await access(nodeGyp, fsConstants.R_OK);
const build = spawnSync(process.execPath, [nodeGyp, "rebuild"], {
  cwd: nativeRoot,
  stdio: "inherit",
  windowsHide: true,
  env: process.env
});
if (build.status !== 0) process.exit(build.status ?? 1);

const metadata = await stat(builtHost);
if (!metadata.isFile() || metadata.size < 16 * 1024) {
  throw new Error("The Windows agent pipe host build did not produce a valid executable.");
}
await mkdir(dirname(stagedHost), { recursive: true });
await copyFile(builtHost, stagedHost);

if (runSelfTest) {
  const test = spawnSync(stagedHost, ["--self-test"], {
    cwd: repositoryRoot,
    stdio: "inherit",
    windowsHide: true,
    timeout: 15_000
  });
  if (test.status !== 0) {
    throw new Error(`The Windows agent pipe host self-test failed (${test.signal ?? test.status ?? "unknown"}).`);
  }
  await relaySelfTest(stagedHost);
}

process.stdout.write(`${stagedHost}\n`);

async function relaySelfTest(hostPath) {
  const relay = spawn(hostPath, ["--parent-pid", String(process.pid)], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { SystemRoot: process.env.SystemRoot, WINDIR: process.env.WINDIR }
  });
  const frames = frameReader(relay.stdout);
  let stderr = "";
  relay.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString("utf8")).slice(0, 8 * 1024);
  });
  const timeout = setTimeout(() => relay.kill(), 10_000);
  timeout.unref();
  try {
    const ready = await bounded(frames.next(1));
    const endpoint = ready.payload.toString("utf8");
    if (!endpoint.startsWith("\\\\.\\pipe\\canvastty-agent-")) {
      throw new Error("The relay self-test received an invalid READY endpoint.");
    }
    const socket = createConnection(endpoint);
    socket.on("error", () => undefined);
    await bounded(once(socket, "connect"));
    const connected = await bounded(frames.next(2));
    if (connected.connectionId === 0) throw new Error("The relay self-test received connection id zero.");

    socket.write(Buffer.from("client-to-host"));
    const inbound = await bounded(frames.next(3));
    if (inbound.connectionId !== connected.connectionId || inbound.payload.toString("utf8") !== "client-to-host") {
      throw new Error("The relay self-test client-to-host payload was corrupted.");
    }

    const response = once(socket, "data");
    relay.stdin.write(encodeFrame(16, connected.connectionId, Buffer.from("host-to-client")));
    if ((await bounded(response))[0].toString("utf8") !== "host-to-client") {
      throw new Error("The relay self-test host-to-client payload was corrupted.");
    }

    // A last message and the close in one write, as the gateway sends an error and closes: the client gets the
    // message before the pipe closes (the host used to drop a write still queued when the close arrived).
    const received = [];
    socket.on("data", (chunk) => received.push(chunk));
    const closed = waitForServerClose(socket);
    relay.stdin.write(Buffer.concat([
      encodeFrame(16, connected.connectionId, Buffer.from("last-words")),
      encodeFrame(17, connected.connectionId, Buffer.alloc(0))
    ]));
    await bounded(Promise.all([closed, frames.next(4)]));
    if (Buffer.concat(received).toString("utf8") !== "last-words") {
      throw new Error("The relay self-test lost the message written just before the close.");
    }
    const exited = once(relay, "exit");
    relay.stdin.write(encodeFrame(18, 0, Buffer.alloc(0)));
    relay.stdin.end();
    const [code] = await bounded(exited);
    if (code !== 0) throw new Error(`The relay self-test host exited with ${code}: ${stderr.trim()}`);
  } finally {
    clearTimeout(timeout);
    if (relay.exitCode === null && relay.signalCode === null) relay.kill();
  }
}

function waitForServerClose(socket) {
  return new Promise((resolve, reject) => {
    let expectedPipeError = false;
    const cleanup = () => {
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onError = (error) => {
      if (error?.code === "EPIPE" || error?.code === "ECONNRESET") {
        expectedPipeError = true;
        return;
      }
      cleanup();
      reject(error);
    };
    const onClose = (hadError) => {
      cleanup();
      if (hadError && !expectedPipeError) {
        reject(new Error("The relay self-test socket closed with an unexpected pipe error."));
        return;
      }
      resolve();
    };
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function frameReader(stream) {
  let buffer = Buffer.alloc(0);
  const queue = [];
  const waiters = [];
  let failure = null;
  const fail = (error) => {
    if (failure) return;
    failure = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  const deliver = (frame) => {
    if (frame.type === 5) {
      fail(new Error(frame.payload.toString("utf8") || "Native relay host reported a fatal error."));
      return;
    }
    const index = waiters.findIndex((waiter) => waiter.type === frame.type);
    if (index < 0) {
      queue.push(frame);
      return;
    }
    waiters.splice(index, 1)[0].resolve(frame);
  };
  stream.on("data", (chunk) => {
    buffer = buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    while (buffer.length >= 16) {
      if (buffer.readUInt32LE(0) !== 0x4850_5443 || buffer.readUInt8(4) !== 1) {
        fail(new Error("Invalid native relay frame."));
        return;
      }
      const length = buffer.readUInt32LE(12);
      if (length > 512 * 1024 + 1) {
        fail(new Error("Oversized native relay frame."));
        return;
      }
      if (buffer.length < 16 + length) return;
      deliver({
        type: buffer.readUInt8(5),
        connectionId: buffer.readUInt32LE(8),
        payload: Buffer.from(buffer.subarray(16, 16 + length))
      });
      buffer = buffer.subarray(16 + length);
    }
  });
  stream.once("error", (error) => fail(error));
  stream.once("end", () => fail(new Error("Native relay stdout ended before the expected frame.")));
  return {
    next(type) {
      if (failure) return Promise.reject(failure);
      const index = queue.findIndex((frame) => frame.type === type);
      if (index >= 0) return Promise.resolve(queue.splice(index, 1)[0]);
      return new Promise((resolve, reject) => waiters.push({ type, resolve, reject }));
    }
  };
}

function encodeFrame(type, connectionId, payload) {
  const frame = Buffer.alloc(16 + payload.length);
  frame.writeUInt32LE(0x4850_5443, 0);
  frame.writeUInt8(1, 4);
  frame.writeUInt8(type, 5);
  frame.writeUInt32LE(connectionId, 8);
  frame.writeUInt32LE(payload.length, 12);
  payload.copy(frame, 16);
  return frame;
}

function bounded(promise, timeoutMs = 5_000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("The Windows relay self-test timed out.")), timeoutMs);
    timeout.unref();
    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      }
    );
  });
}
