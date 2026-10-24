import clip from "../data/dvd-bounce.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "DVD Logo Bounce", category: "scenes",
    note: "\u041e\u0442\u0441\u043a\u043e\u043a DVD \u043b\u043e\u0433\u043e\u0442\u0438\u043f\u0430",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function dvdBounce() {
    return createVideoAsciiClip(clip);
}
