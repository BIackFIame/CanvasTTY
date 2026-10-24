import clip from "../data/anime-girl-smile.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Foot Step On Face", category: "scenes",
    note: "Тян наступили пяткой на лицо",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function animeGirlSmile() {
    return createVideoAsciiClip(clip);
}
