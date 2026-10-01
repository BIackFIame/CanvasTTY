import test from "node:test";
import assert from "node:assert/strict";
import { TerminalPresentation } from "../src/main/services/companion/TerminalPresentation.ts";

// A minimal fake port: 10 sessions, all continuously emitting output, only one ever read (presented).
function makePort(ids) {
  const buffers = new Map(ids.map((id) => [id, ""]));
  return {
    buffers,
    listMetadata: () => ids.map((id) => ({ id, provider: "claude", status: "idle", title: id })),
    geometry: () => ({ cols: 60, rows: 12 }),
    readBuffer: (id) => ({ buffer: buffers.get(id), outputOffset: buffers.get(id).length }),
  };
}

function parsedIds(presentation) {
  return [...presentation.screens]
    .filter(([, screen]) => screen.terminal)
    .map(([id]) => id)
    .sort();
}

test("a presented session's headless parser is disposed once it goes unread, and rebuilds on demand", async () => {
  const now = Date.now;
  let clock = 0;
  Date.now = () => clock;
  try {
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const port = makePort(ids);
    const presentation = new TerminalPresentation(port);

    // The device presents only s0; read it once so its headless screen is made.
    await presentation.read("s0");
    assert.deepEqual(parsedIds(presentation), ["s0"]);

    // All 10 sessions keep emitting PTY output for a while (well under the idle threshold), and s0 is read
    // again periodically the way a device polling a presented session would.
    for (let tick = 0; tick < 5; tick++) {
      clock += 4_000;
      for (const id of ids) {
        const data = `line ${tick} on ${id}\r\n`;
        port.buffers.set(id, port.buffers.get(id) + data);
        presentation.observe("terminal:data", { id, data, outputOffset: port.buffers.get(id).length });
      }
      await presentation.read("s0");
    }
    assert.deepEqual(parsedIds(presentation), ["s0"], "only the presented session ever gets a parser");

    // The device stops presenting s0 (user navigates away / device goes idle) but PTY output for every
    // session, including s0, keeps flowing.
    for (let tick = 0; tick < 6; tick++) {
      clock += 4_000; // 6 * 4s = 24s, past IDLE_SCREEN_MS (20s), with no further reads of anything.
      for (const id of ids) {
        const data = `late line ${tick} on ${id}\r\n`;
        port.buffers.set(id, port.buffers.get(id) + data);
        presentation.observe("terminal:data", { id, data, outputOffset: port.buffers.get(id).length });
      }
    }
    assert.deepEqual(
      parsedIds(presentation),
      [],
      "no session keeps a live headless parser once nobody has read it for a while",
    );

    // Presenting s0 again rebuilds its parser from the retained buffer, showing the latest output even though
    // its old parser was torn down while it kept receiving data.
    const view = await presentation.read("s0");
    assert.match(view.body, /late line 5 on s0/u);
    assert.deepEqual(parsedIds(presentation), ["s0"]);

    presentation.close();
  } finally {
    Date.now = now;
  }
});
