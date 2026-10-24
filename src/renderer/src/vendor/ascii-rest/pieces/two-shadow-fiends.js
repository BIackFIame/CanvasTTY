import clip from "../data/two-shadow-fiends.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

// Two Shadow Fiends swaggering forward with glowing fire claws in synchronized walk.
// Dota 2 community meme converted to coloured Fine Dots ASCII animation.
export const meta = {
    name: "Two Shadow Fiends", category: "scenes",
    note: "two shadow fiends from dota 2 swaggering forward with fiery claws in synchronized split walk",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 2.0, ground: "#07090f", palette: clip.palette,
};

export default function twoShadowFiends() {
    return createVideoAsciiClip(clip);
}
