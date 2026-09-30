import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { handleStdioError } from "../src/main/stdio.ts";

test("logging survives a launcher closing both pipes; other errors still surface", async () => {
  const other = Object.assign(new Error("I/O failure"), { code: "EIO" });
  assert.throws(() => handleStdioError(other), (error) => error === other);

  const moduleUrl = new URL("../src/main/stdio.ts", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import ${JSON.stringify(moduleUrl)};
    import { Console } from 'node:console';
    const logger = new Console({ stdout: process.stdout, stderr: process.stderr, ignoreErrors: false });
    process.on('message', () => {
      logger.log('stdout after launcher exit');
      logger.error('stderr after launcher exit');
      setImmediate(() => {
        logger.error('subsequent IPC error');
        process.disconnect();
      });
    });
    process.send('ready');
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const exited = once(child, "exit");
  await once(child, "message");
  child.stdout.destroy();
  child.stderr.destroy();
  child.send("write");
  assert.deepEqual(await exited, [0, null]);
});
