import clip from "../data/city-night-walk.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Fisheye Cat Shock", category: "scenes",
    note: "Кот в ахуе (Фишай)",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function cityNightWalk() {
    return createVideoAsciiClip(clip);
}
