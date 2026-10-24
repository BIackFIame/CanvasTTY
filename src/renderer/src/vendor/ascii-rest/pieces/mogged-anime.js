import clip from "../data/mogged-anime.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Bocchi Mogged", category: "scenes",
    note: "Боччи замоккана #MOGGED",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function moggedAnime() {
    return createVideoAsciiClip(clip);
}
