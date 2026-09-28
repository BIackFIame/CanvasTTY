import assert from "node:assert/strict";
import test from "node:test";
import { NdjsonDecoderBase, NdjsonLineReader, NdjsonLineTooLongError } from "../src/agent-runtime/ndjson.mjs";

const text = (lines) => lines.map((line) => line.toString("utf8"));

test("lines are cut at newlines across chunks, empty lines included, a split UTF-8 character intact", () => {
  const reader = new NdjsonLineReader({ maxLineBytes: 64 });
  const euro = Buffer.from("€", "utf8");
  assert.deepEqual(text(reader.push(Buffer.concat([Buffer.from("a\n\nb"), euro.subarray(0, 1)]))), ["a", ""]);
  assert.deepEqual(text(reader.push(Buffer.concat([euro.subarray(1), Buffer.from("\nc")]))), ["b€"]);
  assert.deepEqual(text(reader.push("\n")), ["c"]);
  assert.deepEqual(reader.push(""), []);
});

test("a line at the limit passes; one byte over throws by default, complete or unterminated", () => {
  assert.deepEqual(text(new NdjsonLineReader({ maxLineBytes: 4 }).push("abcd\n")), ["abcd"]);
  assert.throws(() => new NdjsonLineReader({ maxLineBytes: 4 }).push("abcde\n"), NdjsonLineTooLongError);
  const unterminated = new NdjsonLineReader({ maxLineBytes: 4 });
  assert.deepEqual(unterminated.push("abc"), []);
  assert.throws(() => unterminated.push("de"), NdjsonLineTooLongError);
});

test("with onOversize a long line is reported once and dropped up to its newline", () => {
  let oversize = 0;
  const reader = new NdjsonLineReader({ maxLineBytes: 4, onOversize: () => { oversize += 1; } });
  assert.deepEqual(text(reader.push("ok\nabcdefgh")), ["ok"]);
  assert.equal(oversize, 1);
  assert.deepEqual(reader.push("still the same long line"), []);
  assert.deepEqual(text(reader.push(" end\nnext\n")), ["next"]);
  assert.deepEqual(text(reader.push("toolong\nfine\n")), ["fine"]);
  assert.equal(oversize, 2);
});

test("the decoder parses messages, skips empty lines and maps both failures to the caller's errors", () => {
  const decoder = () => new NdjsonDecoderBase({ maxLineBytes: 16, tooLarge: () => new Error("too large"), invalid: () => new Error("invalid") });
  const one = decoder();
  assert.deepEqual(one.push('{"a":1}\n\n{"b"'), [{ a: 1 }]);
  assert.deepEqual(one.push(":2}\n"), [{ b: 2 }]);
  assert.throws(() => decoder().push("nope\n"), /invalid/);
  assert.throws(() => decoder().push(`${"x".repeat(17)}\n`), /too large/);
  assert.throws(() => decoder().push("x".repeat(17)), /too large/);
});
