import clip from "../data/fight-club-meme.json" with { type: "json" };
import { createVideoAsciiClip } from "../videoAsciiClip.js";

export const meta = {
    name: "Stark Automate Scam", category: "scenes",
    note: "Тони Старк: Чад ЖПТ автоматизируй наебалово",
    cols: clip.cols, rows: clip.rows, cell: 2, fps: clip.fps, fineDots: true, contain: true,
    still: 0, ground: "#07090f", palette: clip.palette,
};

export default function fightClubMeme() {
    return createVideoAsciiClip(clip);
}
