import clip from "../data/putin-smoking.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Putin Smoking Peephole", category: "scenes",
    note: "Путин затягивается через глазок",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function putinSmoking() {
    return createVideoAsciiClip(clip);
}
