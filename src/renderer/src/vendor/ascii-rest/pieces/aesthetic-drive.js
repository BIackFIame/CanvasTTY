import clip from "../data/aesthetic-drive.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Heater Cat Goy", category: "scenes",
    note: "Кот греется у камина с мыслью «гой»",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function aestheticDrive() {
    return createVideoAsciiClip(clip);
}
