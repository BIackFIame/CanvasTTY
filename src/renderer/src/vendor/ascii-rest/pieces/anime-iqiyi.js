import clip from "../data/anime-iqiyi.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Eren Freedom", category: "scenes",
    note: "Эрен: FREEEEEEDOM!",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function animeIqiyi() {
    return createVideoAsciiClip(clip);
}
