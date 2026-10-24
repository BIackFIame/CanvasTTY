import type { AsciiPiece } from "../../vendor/ascii-rest/mount.js";
import { appendFineDots } from "./asciiFineDots.ts";
import { asciiFrameBounds, type AsciiFrameTransform } from "./asciiFrameBounds.ts";

export function createAsciiGpuRenderer(canvas: OffscreenCanvas, meta: AsciiPiece["meta"]): ((text: string, color?: Uint8Array, pixelRatio?: number, transform?: AsciiFrameTransform) => void) | null {
  const context = canvas.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
  if (!context) return null;
  const gl = context;
  const { cols = 80, rows = 24, cell = 2, palette = ["#f7f4ec"], ground = "#07090f" } = meta;
  const shader = (type: number, source: string): WebGLShader => {
    const result = gl.createShader(type)!;
    gl.shaderSource(result, source);
    gl.compileShader(result);
    if (!gl.getShaderParameter(result, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result) ?? "ASCII shader failed");
    return result;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, shader(gl.VERTEX_SHADER, `#version 300 es
    void main() {
      vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`));
  gl.attachShader(program, shader(gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float;
    uniform sampler2D glyphs, grid, inks;
    uniform vec2 viewport, cells, atlasSize, tileSize, glyphSize;
    uniform vec4 sceneRect;
    uniform float atlasColumns;
    uniform vec3 ground;
    out vec4 outputColor;
    void main() {
      vec2 uv = (vec2(gl_FragCoord.x, viewport.y - gl_FragCoord.y) - sceneRect.xy) / sceneRect.zw;
      if (any(lessThan(uv, vec2(0.0))) || any(greaterThanEqual(uv, vec2(1.0)))) {
        outputColor = vec4(ground, 1.0);
        return;
      }
      vec2 p = uv * cells;
      vec4 data = texelFetch(grid, ivec2(p), 0);
      float slot = round(data.r * 255.0) + round(data.g * 255.0) * 256.0;
      vec2 origin = vec2(mod(slot, atlasColumns), floor(slot / atlasColumns)) * tileSize;
      float alpha = texture(glyphs, (origin + vec2(4.0) + fract(p) * glyphSize) / atlasSize).a;
      vec3 ink = texelFetch(inks, ivec2(round(data.b * 255.0), 0), 0).rgb;
      outputColor = vec4(mix(ground, ink, alpha), 1.0);
    }`));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "ASCII program failed");
  gl.useProgram(program);
  const uniform = (name: string): WebGLUniformLocation | null => gl.getUniformLocation(program, name);
  const viewport = uniform("viewport"), atlasSize = uniform("atlasSize"), tileSize = uniform("tileSize"), glyphSize = uniform("glyphSize");
  const atlasColumns = uniform("atlasColumns");
  const sceneRect = uniform("sceneRect");
  gl.uniform2f(uniform("cells"), cols, rows);
  function texture(unit: number, name: string, filter: number): WebGLTexture {
    const result = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, result);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.uniform1i(uniform(name), unit);
    return result;
  }
  const glyphTexture = texture(0, "glyphs", gl.LINEAR);
  const gridTexture = texture(1, "grid", gl.NEAREST);
  const data = new Uint8Array(cols * rows * 4);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, cols, rows, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  texture(2, "inks", gl.NEAREST);
  const swatches = new OffscreenCanvas(palette.length + 1, 1);
  const swatch = swatches.getContext("2d")!;
  [...palette, ground].forEach((ink, index) => { swatch.fillStyle = ink; swatch.fillRect(index, 0, 1, 1); });
  const rgba = swatch.getImageData(0, 0, palette.length + 1, 1).data;
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, palette.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, rgba.subarray(0, palette.length * 4));
  gl.uniform3f(uniform("ground"), rgba[palette.length * 4] / 255, rgba[palette.length * 4 + 1] / 255, rgba[palette.length * 4 + 2] / 255);
  const slots = new Map<string, number>([[" ", 0]]);
  const atlas = new OffscreenCanvas(1, 1);
  const ink = atlas.getContext("2d")!;
  let atlasCount = 0, scale = 0;
  return (text, color, pixelRatio = 1, transform) => {
    const bounds = asciiFrameBounds(canvas.width, canvas.height, meta, pixelRatio, transform);
    data.fill(0);
    let x = 0, y = 0;
    for (const char of text) {
      if (char === "\n") { x = 0; if (++y >= rows) break; continue; }
      if (x >= cols) { x++; continue; }
      let slot = slots.get(char);
      if (slot === undefined) { slot = slots.size; slots.set(char, slot); }
      const index = (y * cols + x) * 4;
      data[index] = slot & 255;
      data[index + 1] = slot >> 8;
      data[index + 2] = color?.[y * cols + x] ?? 0;
      x++;
    }
    const neededScale = Math.max(4, Math.ceil(Math.max(bounds.width / (cols * 6), bounds.height / (rows * cell * 6))));
    if (atlasCount !== slots.size || scale < neededScale) {
      scale = Math.max(scale, neededScale);
      atlasCount = slots.size;
      const across = Math.min(16, slots.size), down = Math.ceil(slots.size / across);
      const w = 6 * scale + 8, h = cell * 6 * scale + 8;
      atlas.width = across * w;
      atlas.height = down * h;
      for (const [char, slot] of slots) {
        ink.save();
        ink.setTransform(scale, 0, 0, scale, (slot % across) * w + 4, Math.floor(slot / across) * h + 4);
        ink.beginPath(); ink.rect(0, 0, 6, cell * 6); ink.clip();
        ink.fillStyle = "white";
        ink.font = "10px Consolas, 'DejaVu Sans Mono', monospace";
        ink.textBaseline = "middle";
        if (meta.fineDots) {
          ink.beginPath();
          appendFineDots(ink, char, 0, 0, cell * 6);
          ink.fill();
        } else ink.fillText(char, 0, cell * 3, 6);
        ink.restore();
      }
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, glyphTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
      gl.uniform2f(atlasSize, atlas.width, atlas.height);
      gl.uniform2f(tileSize, w, h);
      gl.uniform2f(glyphSize, 6 * scale, cell * 6 * scale);
      gl.uniform1f(atlasColumns, across);
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, gridTexture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, cols, rows, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.uniform2f(viewport, canvas.width, canvas.height);
    gl.uniform4f(sceneRect, bounds.x, bounds.y, bounds.width, bounds.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.flush();
  };
}
