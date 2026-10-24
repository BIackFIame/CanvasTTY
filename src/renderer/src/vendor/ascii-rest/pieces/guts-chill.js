import clip from "../data/guts-chill.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Guts Theme Chilling", category: "scenes",
    note: "Гатс на чилле под луной (Guts Theme)",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function gutsChill() {
    return createVideoAsciiClip(clip);
}
