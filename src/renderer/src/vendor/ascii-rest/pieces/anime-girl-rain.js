import clip from "../data/anime-girl-rain.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Hookah Kittens", category: "scenes",
    note: "Котята на вписке с кальяном",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function animeGirlRain() {
    return createVideoAsciiClip(clip);
}
