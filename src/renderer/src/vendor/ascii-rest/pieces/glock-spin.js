import clip from "../data/glock-spin.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

// Local user-requested conversion of https://www.youtube.com/watch?v=n7HiYeTyh_w.
// This source clip is separate from the upstream ascii.rest MIT artwork.
export const meta = {
    name: "Spinning Glock", category: "scenes",
    note: "a metallic Glock rotating on black, converted to coloured ASCII",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function glockSpin() {
    return createVideoAsciiClip(clip);
}
