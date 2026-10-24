import clip from "../data/loom-animation.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Freak GTFO Meme", category: "scenes",
    note: "Ебать ты фрик пошёл нахуй",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function loomAnimation() {
    return createVideoAsciiClip(clip);
}
