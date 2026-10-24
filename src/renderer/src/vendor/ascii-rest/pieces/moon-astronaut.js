import clip from "../data/moon-astronaut.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

// Astronaut casually lounging on the Moon drinking cold beer with Earth view.
// Fine-dots ASCII animation with twinkling stars and cosmic glow.
export const meta = {
    name: "Astronaut on Moon", category: "scenes",
    note: "astronaut lounging on the moon drinking beer with earth view",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function moonAstronaut() {
    return createVideoAsciiClip(clip);
}
