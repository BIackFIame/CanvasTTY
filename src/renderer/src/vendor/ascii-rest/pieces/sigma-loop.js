import clip from "../data/sigma-loop.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Cat Drill Lobotomy", category: "scenes",
    note: "Кот делает лоботомию дрелью",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function sigmaLoop() {
    return createVideoAsciiClip(clip);
}
