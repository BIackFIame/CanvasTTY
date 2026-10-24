export function createVideoAsciiClip(clip) {
    const cells = clip.cols * clip.rows;
    const frameCount = clip.frames.length;
    const cachedTexts = new Array(frameCount);
    const cachedColors = new Array(frameCount);

    function decodeFrame(index) {
        const packed = clip.frames[index];
        const bytes = atob(packed.slice(1));
        const frameGlyphs = new Array(cells);
        const frameColors = new Uint8Array(cells);

        if (packed[0] === "r") {
            let cell = 0;
            for (let offset = 0; offset < bytes.length; offset += 3) {
                const end = cell + bytes.charCodeAt(offset);
                const g = clip.ramp[bytes.charCodeAt(offset + 1)];
                const c = bytes.charCodeAt(offset + 2);
                frameGlyphs.fill(g, cell, end);
                frameColors.fill(c, cell, end);
                cell = end;
            }
        } else {
            for (let cell = 0; cell < cells; cell++) {
                frameGlyphs[cell] = clip.ramp[bytes.charCodeAt(cell * 2)];
                frameColors[cell] = bytes.charCodeAt(cell * 2 + 1);
            }
        }

        const flat = frameGlyphs.join("");
        const lines = [];
        for (let row = 0; row < clip.rows; row++) {
            lines.push(flat.slice(row * clip.cols, (row + 1) * clip.cols));
        }
        cachedTexts[index] = lines.join("\n");
        cachedColors[index] = frameColors;
    }

    return (time, { color } = {}) => {
        const frameNumber = Math.floor(time * clip.fps + 1e-8);
        const index = ((frameNumber % frameCount) + frameCount) % frameCount;
        if (!cachedTexts[index]) {
            decodeFrame(index);
        }
        color?.set(cachedColors[index]);
        return cachedTexts[index];
    };
}
