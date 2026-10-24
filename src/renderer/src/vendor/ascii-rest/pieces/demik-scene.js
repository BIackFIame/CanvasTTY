import clip from "../data/demik-scene.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "War Criminal Cat", category: "scenes",
    note: "Кот военный преступник (я нечайно)",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function demikScene() {
    return createVideoAsciiClip(clip);
}
