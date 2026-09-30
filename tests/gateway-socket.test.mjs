import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  closeServer,
  listenOnEndpoint,
  makePrivateDirectory,
  removeEndpoint,
  tokenDigest,
  tokenMatches
} from "../src/main/services/gatewaySocket.ts";

test("a token matches only its own digest, and a missing digest never matches", () => {
  const digest = tokenDigest("secret-token");
  assert.equal(digest.length, 32);
  assert.equal(tokenMatches("secret-token", digest), true);
  assert.equal(tokenMatches("secret-tokeN", digest), false);
  assert.equal(tokenMatches("", digest), false);
  assert.equal(tokenMatches("secret-token", null), false);
  assert.equal(tokenMatches("secret-token", Buffer.alloc(16)), false);
});

test("an endpoint lives in a 0700 directory, its socket is 0600, and removal leaves nothing", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-gw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, "d");
  await makePrivateDirectory(directory);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  const endpoint = join(directory, "s.sock");
  const server = createServer((socket) => socket.end("hi\n"));
  await listenOnEndpoint(server, endpoint);
  assert.equal((await stat(endpoint)).mode & 0o777, 0o600);
  const reply = await new Promise((resolve, reject) => {
    const socket = createConnection(endpoint);
    let data = "";
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
  });
  assert.equal(reply, "hi\n");
  await closeServer(server);
  await closeServer(server);
  await removeEndpoint(endpoint, directory, { socketFile: true });
  await assert.rejects(stat(directory), { code: "ENOENT" });
  await removeEndpoint(endpoint, directory, { socketFile: true });
});

test("a second listener on a taken endpoint fails instead of hanging", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "ctty-gw-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const endpoint = join(root, "s.sock");
  const first = createServer();
  await listenOnEndpoint(first, endpoint);
  t.after(() => closeServer(first));
  await assert.rejects(listenOnEndpoint(createServer(), endpoint), { code: "EADDRINUSE" });
});
