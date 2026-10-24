import clip from "../data/blade-runner-2049.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

// Joi's giant pink/cyan hologram looking down at Officer K in the neon rain from Blade Runner 2049.
// Fine-dots ASCII animation with scanlines and atmospheric cyberpunk lighting.
export const meta = {
    name: "Blade Runner 2049", category: "scenes",
    note: "joi giant hologram looking down at officer k in the neon rain from blade runner 2049",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 2.0, ground: "#07090f", palette: clip.palette,
};

export default function bladeRunner2049() {
    return createVideoAsciiClip(clip);
}
