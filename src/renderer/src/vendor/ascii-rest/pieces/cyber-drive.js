import clip from "../data/cyber-drive.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Miku in Oil", category: "scenes",
    note: "Мику на масле",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function cyberDrive() {
    return createVideoAsciiClip(clip);
}
