import clip from "../data/oguzki-bezdari.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Chef Barinov Oguzki", category: "scenes",
    note: "Шеф Баринов: БЕЗДАРИ ОГУЗКИ!",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function oguzkiBezdari() {
    return createVideoAsciiClip(clip);
}
