import clip from "../data/jojo-bizarre.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Jotaro Yare Yare", category: "scenes",
    note: "Джотаро: Яре-яре дазе...",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function jojoBizarre() {
    return createVideoAsciiClip(clip);
}
