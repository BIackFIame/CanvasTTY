// Fixed-rate terminal output for scripts/bench-runtime.mjs: `node flood.mjs <KB per second> <seconds>`.
// Coloured, numbered log lines, written every 50 ms.
const [kbps = "256", seconds = "20"] = process.argv.slice(2);
const perTick = Math.round((Number(kbps) * 1024) / 20);
const end = Date.now() + Number(seconds) * 1000;
let n = 0;
const line = () => `\x1b[36m${String(n++).padStart(8, "0")}\x1b[0m bench \x1b[1mflood\x1b[0m src/main/services/Example.ts:${n % 997} value=${(n * 7919) % 100003}\r\n`;
const timer = setInterval(() => {
  let chunk = "";
  while (chunk.length < perTick) chunk += line();
  process.stdout.write(chunk);
  if (Date.now() >= end) { clearInterval(timer); process.stdout.write("\r\nflood done\r\n"); }
}, 50);
