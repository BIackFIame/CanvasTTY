import clip from "../data/discipline-routine.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Discipline Phonk", category: "scenes",
    note: "DISCIPLINE под фонк",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function disciplineRoutine() {
    return createVideoAsciiClip(clip);
}
