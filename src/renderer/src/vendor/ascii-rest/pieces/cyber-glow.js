import clip from "../data/cyber-glow.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Wake Up Goyim", category: "scenes",
    note: "Подъём гои!",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function cyberGlow() {
    return createVideoAsciiClip(clip);
}
