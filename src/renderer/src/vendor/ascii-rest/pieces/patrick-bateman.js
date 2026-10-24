import clip from "../data/patrick-bateman.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Bateman Jump Rope", category: "scenes",
    note: "Бейтман на скакалке (Сигма разминка)",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function patrickBateman() {
    return createVideoAsciiClip(clip);
}
