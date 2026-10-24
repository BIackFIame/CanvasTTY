import clip from "../data/anime-vibe.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Chilled Sloth", category: "scenes",
    note: "Ленивец на чилле: Да похуй)",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function animeVibe() {
    return createVideoAsciiClip(clip);
}
