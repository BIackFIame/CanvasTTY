// Startup bench preload (--frames): records, frame by frame from the first animation frame of each document, what
// the centre of the content area shows — the colour of the first opaque element under that point and its class —
// and keeps only the changes. A dark flash between the empty window and the canvas shows up as a dark entry.
const { contextBridge } = require("electron");

contextBridge.executeInMainWorld({
  func: () => {
    const changes = [];
    window.__benchFrames = changes;
    let last = "";
    const opaque = (element) => {
      for (let node = element; node; node = node.parentElement) {
        const color = getComputedStyle(node).backgroundColor;
        const match = /rgba?\(([\d.]+), ([\d.]+), ([\d.]+)(?:, ([\d.]+))?\)/u.exec(color);
        if (match && (match[4] === undefined || Number(match[4]) > 0.5)) {
          return { node, rgb: [Number(match[1]), Number(match[2]), Number(match[3])] };
        }
      }
      return null;
    };
    const frame = (at) => {
      const x = Math.round(innerWidth / 2);
      const y = Math.round(innerHeight * 0.6);
      const hit = document.body ? opaque(document.elementFromPoint(x, y)) : null;
      const what = hit ? `${hit.node.tagName.toLowerCase()}.${String(hit.node.className).split(" ")[0]}` : "none";
      const rgb = hit ? hit.rgb : null;
      const key = `${location.protocol}|${what}|${rgb}`;
      if (key !== last) {
        last = key;
        const luminance = rgb ? Math.round(0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) : null;
        changes.push({ epochMs: Math.round(performance.timeOrigin + at), page: location.protocol, what, luminance });
      }
      if (changes.length < 200 && at < 5000) requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
});
