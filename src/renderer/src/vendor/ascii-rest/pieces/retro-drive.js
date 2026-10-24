import clip from "../data/retro-drive.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Ruble Stacks Flex", category: "scenes",
    note: "Залутал с завода (Пачки бабла)",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function retroDrive() {
    return createVideoAsciiClip(clip);
}
