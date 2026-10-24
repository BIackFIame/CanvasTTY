import clip from "../data/tyler-durden.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

// Tyler Durden smoking in red leather jacket and sunglasses from Fight Club.
// Fine-dots ASCII animation with slow-motion smoke and rim lighting.
export const meta = {
    name: "Tyler Durden", category: "scenes",
    note: "tyler durden smoking in red leather jacket and sunglasses from fight club",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function tylerDurden() {
    return createVideoAsciiClip(clip);
}
