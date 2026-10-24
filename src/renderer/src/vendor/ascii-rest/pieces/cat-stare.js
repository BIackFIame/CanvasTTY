import clip from "../data/cat-stare.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Time to Lock In", category: "scenes",
    note: "Time to lock in (Тандемный кодинг)",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function catStare() {
    return createVideoAsciiClip(clip);
}
