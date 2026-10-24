import clip from "../data/pixel-runner.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Anti Anime Flag", category: "scenes",
    note: "Аниме для хуесосов (Флаг)",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function pixelRunner() {
    return createVideoAsciiClip(clip);
}
