import clip from "../data/eshkere-cats.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Eshkere Cat Dance", category: "scenes",
    note: "Котики водят хоровод: ЭЩКЕРЕ",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function eshkereCats() {
    return createVideoAsciiClip(clip);
}
