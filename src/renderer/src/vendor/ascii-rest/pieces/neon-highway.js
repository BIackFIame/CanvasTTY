import clip from "../data/neon-highway.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Boxer Cat on Hood", category: "scenes",
    note: "Рыжий кот-боксёр на районе",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function neonHighway() {
    return createVideoAsciiClip(clip);
}
