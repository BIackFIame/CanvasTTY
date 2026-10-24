import clip from "../data/okak-cat.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Okak Hooded Cat", category: "scenes",
    note: "Кот в капюшоне: ОКАК",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function okakCat() {
    return createVideoAsciiClip(clip);
}
