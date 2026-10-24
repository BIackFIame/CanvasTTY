import clip from "../data/skeleton-dance.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Skeleton Horde Flex", category: "scenes",
    note: "Хор скелетов флексит на сцене",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function skeletonDance() {
    return createVideoAsciiClip(clip);
}
