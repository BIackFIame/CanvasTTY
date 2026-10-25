'use strict';
// SPDX-License-Identifier: MIT
// Offline renderer. Uses only the supplied installed sharp; does not start a browser or device.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const sharp = require(process.env.CANVASLINK_SHARP || 'sharp');
const root = path.resolve(__dirname, '..');
const out = __dirname;
const geometrySource = 'android/res/drawable/ic_launcher_foreground.xml';
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

function parse(text) {
  const result = spawnSync('python3', ['-c',
    'import sys,json,xml.etree.ElementTree as E\nr=E.fromstring(sys.stdin.read())\nprint(json.dumps([{"tag":e.tag,"attrs":e.attrib,"text":e.text} for e in r.iter()]))'],
  { input: text, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr);
  return JSON.parse(result.stdout);
}

const android = name => `{http://schemas.android.com/apk/res/android}${name}`;
const rails = parse(read(geometrySource)).filter(n => n.tag === 'path').map(n => ({
  fill: n.attrs[android('fillColor')], d: n.attrs[android('pathData')]
}));
const background = parse(read('android/res/values/colors.xml')).find(n => n.attrs.name === 'icon_background').text.trim();
const pathTags = (tint = null) => rails.map(p => `<path fill="${tint || p.fill}" d="${p.d}"/>`).join('');

function maskShape(mask) {
  if (mask === 'circle') return '<circle cx="54" cy="54" r="36"/>';
  if (mask === 'square') return '<rect x="18" y="18" width="72" height="72"/>';
  if (mask !== 'squircle') throw new Error(`Unknown mask: ${mask}`);
  const points = [];
  for (let i = 0; i <= 256; i++) {
    const t = i / 256 * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
    const x = 54 + 36 * Math.sign(c) * Math.sqrt(Math.abs(c));
    const y = 54 + 36 * Math.sign(s) * Math.sqrt(Math.abs(s));
    points.push(`${i ? 'L' : 'M'}${x.toFixed(6)} ${y.toFixed(6)}`);
  }
  return `<path d="${points.join('')}Z"/>`;
}

function maskedSvg(size, mask, tint = null, bg = background) {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="18 18 72 72"><defs><clipPath id="mask">${maskShape(mask)}</clipPath></defs><g clip-path="url(#mask)"><rect width="108" height="108" fill="${bg}"/>${pathTags(tint)}</g></svg>`);
}

async function safeZoneMetrics() {
  const image = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 108 108">${pathTags()}</svg>`);
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let radius = 0, minX = 108, minY = 108, maxX = 0, maxY = 0;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] < 128) continue;
    const px = (x + .5) / 10, py = (y + .5) / 10;
    radius = Math.max(radius, Math.hypot(px - 54, py - 54));
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  return { samplePixelsPerDp: 10, alphaThreshold: 128, maxRadiusDp: +radius.toFixed(4), safeRadiusDp: 33,
    boundsDp: { minX, minY, maxX, maxY } };
}

async function main() {
  const previews = [];
  const images = new Map();
  for (const size of [24, 32, 48, 64, 128, 512]) for (const mask of ['square', 'circle', 'squircle']) {
    const png = await sharp(maskedSvg(size, mask)).png().toBuffer();
    const file = `verification/icon-${mask}-${size}.png`;
    fs.writeFileSync(path.join(root, file), png);
    images.set(`${mask}-${size}`, png);
    previews.push({ file, mask, width: size, height: size, sha256: sha256(png) });
  }
  const themed = await sharp(maskedSvg(128, 'circle', '#213216', '#d6ef88')).png().toBuffer();
  fs.writeFileSync(path.join(out, 'icon-monochrome-128.png'), themed);
  const sourcePreview = await sharp(path.join(root, 'design/canvaslink-icon.svg')).resize(512, 512).png().toBuffer();
  fs.writeFileSync(path.join(out, 'icon-source-square-512.png'), sourcePreview);
  const safeSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="216" height="216" viewBox="0 0 108 108"><rect width="108" height="108" rx="4" fill="${background}"/>${pathTags()}<rect x="18" y="18" width="72" height="72" fill="none" stroke="#668069" stroke-width=".6" stroke-dasharray="2 2"/><circle cx="54" cy="54" r="33" fill="none" stroke="#d6ef88" stroke-width=".6" stroke-dasharray="2 2"/></svg>`);
  const safeZone = await sharp(safeSvg).png().toBuffer();
  fs.writeFileSync(path.join(out, 'icon-safe-zone.png'), safeZone);

  const labels = [];
  const overlays = [];
  const text = (x, y, value, size = 16, color = '#95a592', weight = 400) => `<text x="${x}" y="${y}" fill="${color}" font-family="sans-serif" font-size="${size}" font-weight="${weight}">${value}</text>`;
  labels.push(text(60, 65, 'CanvasLink', 36, '#edf1e6', 600));
  labels.push(text(60, 101, 'LINKED WINDOWS / ORIGINAL VECTOR MARK', 13, '#a9bc9c', 500));
  for (const [index, mask] of ['square', 'circle', 'squircle'].entries()) {
    const left = 60 + index * 416;
    labels.push(text(left, 145, `${String(index + 1).padStart(2, '0')} / ${mask.toUpperCase()}`, 13, '#d6ef88', 600));
    overlays.push({ input: await sharp(images.get(`${mask}-512`)).resize(320, 320).toBuffer(), left: left + 16, top: 170 });
    labels.push(text(left, 530, mask === 'square' ? 'Remote window + touch surface' : mask === 'circle' ? 'Circle mask / no critical clipping' : 'Exponent-4 squircle / no clipping', 15, '#edf1e6'));
    labels.push(text(left, 621, 'SMALL-SIZE CHECK / 1x', 12, '#a9bc9c', 500));
    for (const [i, size] of [24, 32, 48, 64].entries()) {
      const center = left + [36, 104, 188, 292][i];
      overlays.push({ input: images.get(`${mask}-${size}`), left: center - size / 2, top: 688 - size / 2 });
      labels.push(text(center - 9, 750, String(size), 13));
    }
  }
  labels.push('<path d="M60 572H1260M60 795H1260" stroke="#2a382c"/>');
  overlays.push({ input: themed, left: 60, top: 844 });
  labels.push(text(216, 878, 'API 33+ / THEMED SILHOUETTE', 13, '#d6ef88', 600));
  labels.push(text(216, 910, 'Same geometry; launcher chooses the tint.', 16, '#edf1e6'));
  labels.push(text(216, 940, 'Example colors, not a device capture.', 13));
  overlays.push({ input: safeZone, left: 1044, top: 819 });
  labels.push(text(696, 873, '108dp layer / 72dp viewport', 16, '#edf1e6'));
  labels.push(text(696, 905, '66dp critical safe circle', 16, '#d6ef88'));
  labels.push(text(696, 937, 'Filled rails / no text / no effects', 13));
  labels.push(text(60, 1039, 'OFFLINE ANDROID-VECTOR RENDERS / 24–512px / NO DEVICE INSTALL', 12));
  const sheetSvg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="1320" height="1080"><rect width="1320" height="1080" fill="#0c120e"/>${labels.join('')}</svg>`);
  const sheet = await sharp(sheetSvg).composite(overlays).png().toBuffer();
  fs.writeFileSync(path.join(out, 'icon-contact-sheet.png'), sheet);
  const manifest = {
    geometrySource,
    sourceSvg: 'design/canvaslink-icon.svg',
    sourceSha256: sha256(fs.readFileSync(path.join(root, 'design/canvaslink-icon.svg'))),
    vectorSha256: sha256(fs.readFileSync(path.join(root, geometrySource))),
    adaptiveViewport: { x: 18, y: 18, size: 72, layerSize: 108 },
    safeZone: await safeZoneMetrics(),
    maskNote: 'Circle and exponent-4 superellipse are geometric preview masks, not OEM launcher captures.',
    license: 'MIT; original project-specific geometry, no third-party artwork or fonts embedded.',
    renderer: { sharp: sharp.versions.sharp, librsvg: sharp.versions.rsvg },
    previews,
    contactSheet: { file: 'verification/icon-contact-sheet.png', width: 1320, height: 1080, sha256: sha256(sheet) }
  };
  fs.writeFileSync(path.join(out, 'icon-previews.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ previews: previews.length, sheet: manifest.contactSheet.file, safeZone: manifest.safeZone }));
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
