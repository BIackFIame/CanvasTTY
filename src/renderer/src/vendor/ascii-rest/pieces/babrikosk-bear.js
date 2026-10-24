import clip from "../data/babrikosk-bear.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Procrastinator Clock", category: "scenes",
    note: "Часы прокрастинатора: везде «Ща»",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function babrikoskBear() {
    return createVideoAsciiClip(clip);
}
