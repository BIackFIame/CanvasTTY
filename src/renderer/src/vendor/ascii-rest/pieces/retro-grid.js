import clip from "../data/retro-grid.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Monkey Glock Tish", category: "scenes",
    note: "Обезьяна спит со стволом: ТИШ",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function retroGrid() {
    return createVideoAsciiClip(clip);
}
