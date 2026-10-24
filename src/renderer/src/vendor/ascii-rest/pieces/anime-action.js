import clip from "../data/anime-action.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Albion PvP Clash", category: "scenes",
    note: "Лютый замес в Альбионе",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function animeAction() {
    return createVideoAsciiClip(clip);
}
