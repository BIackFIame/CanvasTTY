import clip from "../data/basketball-neon.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

// Local user-requested conversion of https://www.youtube.com/watch?v=LmaINvjJqsQ.
// This source clip is separate from the upstream ascii.rest MIT artwork.
export const meta = {
    name: "Neon basketball", category: "scenes",
    note: "a basketball sequence in violet light, converted to coloured ASCII",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, fullBleed: true,
    still: 1.5, ground: "#07090f", palette: clip.palette,
};

export default function basketballNeon() {
    return createVideoAsciiClip(clip);
}
