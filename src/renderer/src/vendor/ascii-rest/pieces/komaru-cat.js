import clip from "../data/komaru-cat.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Komaru 2kg Salt Party", category: "scenes",
    note: "Партия Комару выдаёт 2 кг соли",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function komaruCat() {
    return createVideoAsciiClip(clip);
}
