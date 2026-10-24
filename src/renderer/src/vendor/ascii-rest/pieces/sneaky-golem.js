import clip from "../data/sneaky-golem.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Sneaky Dark Golem", category: "scenes",
    note: "Коварный голем впотьмах",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function sneakyGolem() {
    return createVideoAsciiClip(clip);
}
