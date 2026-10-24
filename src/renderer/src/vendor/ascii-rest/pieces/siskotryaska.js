import clip from "../data/siskotryaska.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Siskotryaska", category: "scenes",
    note: "сиськотряска",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function siskotryaska() {
    return createVideoAsciiClip(clip);
}
