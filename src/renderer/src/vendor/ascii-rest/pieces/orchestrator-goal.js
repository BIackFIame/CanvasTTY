import clip from "../data/orchestrator-goal.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Orchestrator Goal 48h", category: "scenes",
    note: "Оркестратор проверяет /goal 48ч",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function orchestratorGoal() {
    return createVideoAsciiClip(clip);
}
