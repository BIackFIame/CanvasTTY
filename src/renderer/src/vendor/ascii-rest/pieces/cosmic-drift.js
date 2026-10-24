import clip from "../data/cosmic-drift.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Dog Hentai Shock", category: "scenes",
    note: "Пёс охуел от хентай-плаката",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function cosmicDrift() {
    return createVideoAsciiClip(clip);
}
