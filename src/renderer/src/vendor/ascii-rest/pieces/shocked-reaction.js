import clip from "../data/shocked-reaction.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "GTO Vice Principal", category: "scenes",
    note: "Завуч из GTO орёт в своей Кресте",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function shockedReaction() {
    return createVideoAsciiClip(clip);
}
