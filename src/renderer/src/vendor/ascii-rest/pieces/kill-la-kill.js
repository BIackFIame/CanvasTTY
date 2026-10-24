import clip from "../data/kill-la-kill.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

// Local user-requested conversion of Kill la Kill Kamui transformation sync.
// Studio TRIGGER animation converted to coloured fine-dots ASCII.
export const meta = {
    name: "Kill la Kill", category: "scenes",
    note: "satsuki and ryuko kamui transformation in synchronized split screen",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 5.3, ground: "#07090f", palette: clip.palette,
};

export default function killLaKill() {
    return createVideoAsciiClip(clip);
}
