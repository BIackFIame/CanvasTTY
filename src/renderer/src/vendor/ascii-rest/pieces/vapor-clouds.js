import clip from "../data/vapor-clouds.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Monkey Jailed for Gifs", category: "scenes",
    note: "Обезьяна: 20 лет за кражу гифок",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function vaporClouds() {
    return createVideoAsciiClip(clip);
}
