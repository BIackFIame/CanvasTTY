import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import test from "node:test";

import {
  WINDOWS_PIPE_RELAY_PROTOCOL,
  WindowsPipeHostTransport
} from "../src/main/services/agent-browser/WindowsPipeHostTransport.ts";

const protocol = WINDOWS_PIPE_RELAY_PROTOCOL;

function frame(type, connectionId, payload = Buffer.alloc(0)) {
  const result = Buffer.alloc(protocol.headerBytes + payload.length);
  result.writeUInt32LE(protocol.magic, 0);
  result.writeUInt8(protocol.version, 4);
  result.writeUInt8(type, 5);
  result.writeUInt32LE(connectionId, 8);
  result.writeUInt32LE(payload.length, 12);
  payload.copy(result, protocol.headerBytes);
  return result;
}

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + protocol.headerBytes <= buffer.length) {
    assert.equal(buffer.readUInt32LE(offset), protocol.magic);
    const length = buffer.readUInt32LE(offset + 12);
    if (offset + protocol.headerBytes + length > buffer.length) break;
    frames.push({
      type: buffer.readUInt8(offset + 5),
      connectionId: buffer.readUInt32LE(offset + 8),
      payload: buffer.subarray(offset + protocol.headerBytes, offset + protocol.headerBytes + length)
    });
    offset += protocol.headerBytes + length;
  }
  return frames;
}

function fakeHost() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.kill = () => {
    if (child.exitCode !== null) return false;
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  };
  child.stdin.once("finish", () => child.kill());
  return child;
}

test("Windows pipe transport publishes only READY endpoints and relays bounded socket frames", async () => {
  const child = fakeHost();
  const receivedByHost = [];
  child.stdin.on("data", (chunk) => receivedByHost.push(Buffer.from(chunk)));
  const sockets = [];
  const transport = new WindowsPipeHostTransport({
    platform: "win32",
    hostPath: join(process.cwd(), "package.json"),
    spawnHost: () => child
  });

  const starting = transport.start((socket) => sockets.push(socket));
  child.stdout.write(frame(
    protocol.hostToParent.ready,
    0,
    Buffer.from("\\\\.\\pipe\\canvastty-agent-0123456789abcdef", "utf8")
  ));
  assert.equal(await starting, "\\\\.\\pipe\\canvastty-agent-0123456789abcdef");
  assert.equal(transport.isRunning, true);

  child.stdout.write(frame(protocol.hostToParent.connect, 7));
  assert.equal(sockets.length, 1);
  const dataPromise = once(sockets[0], "data");
  child.stdout.write(frame(protocol.hostToParent.data, 7, Buffer.from("hello")));
  assert.equal((await dataPromise)[0].toString("utf8"), "hello");

  sockets[0].write(Buffer.from("world"));
  const writes = decodeFrames(Buffer.concat(receivedByHost));
  assert.deepEqual(writes.at(-1), {
    type: protocol.parentToHost.write,
    connectionId: 7,
    payload: Buffer.from("world")
  });

  const closed = once(sockets[0], "close");
  child.stdout.write(frame(protocol.hostToParent.close, 7));
  await closed;
  await transport.close();
  assert.equal(transport.isRunning, false);
  const finalFrames = decodeFrames(Buffer.concat(receivedByHost));
  assert.equal(finalFrames.at(-1).type, protocol.parentToHost.shutdown);
});

test("Windows pipe transport rejects connection frames before protected READY", async () => {
  const child = fakeHost();
  const transport = new WindowsPipeHostTransport({
    platform: "win32",
    hostPath: join(process.cwd(), "package.json"),
    spawnHost: () => child
  });
  const fatal = once(transport, "fatal");
  const starting = transport.start(() => undefined);
  child.stdout.write(frame(protocol.hostToParent.connect, 1));
  await assert.rejects(starting, /before READY/i);
  assert.match((await fatal)[0].message, /before READY/i);
});

test("Windows pipe transport rejects oversized native relay headers before allocation", async () => {
  const child = fakeHost();
  const transport = new WindowsPipeHostTransport({
    platform: "win32",
    hostPath: join(process.cwd(), "package.json"),
    spawnHost: () => child
  });
  const starting = transport.start(() => undefined);
  const invalid = frame(protocol.hostToParent.ready, 0);
  invalid.writeUInt32LE(protocol.maxPayloadBytes + 1, 12);
  child.stdout.write(invalid.subarray(0, protocol.headerBytes));
  await assert.rejects(starting, /bounded payload/i);
});

test("Windows pipe transport turns host pipe errors into a transport failure instead of an uncaught exception", async () => {
  for (const stream of ["stdin", "stdout", "stderr"]) {
    const child = fakeHost();
    const sockets = [];
    const transport = new WindowsPipeHostTransport({
      platform: "win32",
      hostPath: join(process.cwd(), "package.json"),
      spawnHost: () => child
    });
    const fatal = [];
    transport.on("fatal", (error) => fatal.push(error));
    const starting = transport.start((socket) => sockets.push(socket));
    child.stdout.write(frame(protocol.hostToParent.ready, 0, Buffer.from("\\\\.\\pipe\\canvastty-agent-0123456789abcdef", "utf8")));
    await starting;
    child.stdout.write(frame(protocol.hostToParent.connect, 3));
    let closed = false;
    const socketErrors = [];
    sockets[0].on("error", (error) => socketErrors.push(error));
    sockets[0].on("close", () => { closed = true; });

    const epipe = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    assert.doesNotThrow(() => child[stream].emit("error", epipe), `${stream} error is handled`);
    if (stream === "stderr") {
      // Diagnostics only: losing stderr does not end the relay.
      assert.equal(transport.isRunning, true);
      await transport.close();
      continue;
    }
    assert.equal(closed, true);
    assert.equal(socketErrors.length, 1);
    assert.equal(transport.isRunning, false);
    assert.equal(fatal.length, 1);
    assert.match(fatal[0].message, /EPIPE/);
    assert.equal(sockets[0].write(Buffer.from("late")), false);
  }
});
