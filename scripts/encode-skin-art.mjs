// Encode built-in pixel theme art (PNG masters) to the AVIF files the renderer bundles.
//   node scripts/encode-skin-art.mjs path/to/frame.png [...]   (needs avifenc from libavif on PATH)
// Settings: full-resolution 4:4:4 chroma so hard pixel edges keep their colour, lossless alpha so the transparent
// terminal opening stays exact, quality 92 for terminal frames and 95 for full-window backgrounds (their fine
// texture is the most sensitive). Measured against the PNG masters: SSIM >= 0.99 on frames, PSNR >= 44 dB overall.
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";

const inputs = process.argv.slice(2).filter((path) => path.endsWith(".png"));
if (!inputs.length) {
  console.error("usage: node scripts/encode-skin-art.mjs <file.png> [...]");
  process.exit(2);
}
for (const input of inputs) {
  const quality = input.includes("theme-backgrounds") ? "95" : "92";
  const output = input.replace(/\.png$/u, ".avif");
  const result = spawnSync("avifenc", ["-j", "2", "-s", "4", "-y", "444", "-q", quality, "--qalpha", "100", input, output], { stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(`avifenc failed for ${input}${result.error ? `: ${result.error.message}` : ""}`);
    process.exit(1);
  }
  if (process.argv.includes("--remove-png")) rmSync(input);
}
