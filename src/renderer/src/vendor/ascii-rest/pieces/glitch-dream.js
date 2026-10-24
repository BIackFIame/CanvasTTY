import clip from "../data/glitch-dream.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Gosling Confusion", category: "scenes",
    note: "Гослинг: опять эти ну как их там блять",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function glitchDream() {
    return createVideoAsciiClip(clip);
}
