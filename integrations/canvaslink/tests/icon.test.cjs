'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const sharp = require(process.env.CANVASLINK_SHARP || 'sharp');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const exists = file => fs.existsSync(path.join(root, file));
const ns = 'http://schemas.android.com/apk/res/android';

function xml(text) {
  const parsed = spawnSync('python3', ['-c',
    'import sys,json,xml.etree.ElementTree as E\nr=E.fromstring(sys.stdin.read())\nprint(json.dumps([{"tag":e.tag,"attrs":e.attrib,"text":e.text} for e in r.iter()]))'],
  { input: text, encoding: 'utf8' });
  assert.equal(parsed.status, 0, `XML must be well formed: ${parsed.stderr}`);
  return JSON.parse(parsed.stdout);
}

function source() {
  assert.ok(exists('design/canvaslink-icon.svg'), 'Original CanvasLink SVG is missing');
  const text = read('design/canvaslink-icon.svg');
  const nodes = xml(text);
  return { text, nodes, paths: nodes.filter(node => node.tag.endsWith('}path')) };
}

function foregroundSvg(paths) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="108" height="108" viewBox="0 0 108 108">${paths.map(p => `<path fill="${p.attrs.fill}" d="${p.attrs.d}"/>`).join('')}</svg>`;
}

// Source geometry is checked independently of Android conversion and launcher masks.
test('icon: original two-window mark uses the UI palette and stays inside the 66dp safe circle', async () => {
  const { text, nodes, paths } = source();
  assert.match(text, /SPDX-License-Identifier: MIT/);
  assert.match(text, /Original geometry created for CanvasLink/);
  assert.deepEqual(nodes[0].attrs.viewBox, '0 0 108 108');
  assert.deepEqual(paths.map(p => p.attrs.id), ['desktop-window', 'touch-window']);
  assert.deepEqual(paths.map(p => p.attrs.fill.toLowerCase()), ['#edf1e6', '#d6ef88']);
  const background = nodes.find(n => n.tag.endsWith('}rect'));
  assert.equal(background.attrs.fill.toLowerCase(), '#121814');
  assert.equal(background.attrs.width, '108');
  assert.equal(background.attrs.height, '108');
  assert.ok(!/<(?:text|image|use|filter|linearGradient|radialGradient)\b|\b(?:stroke|transform)=/i.test(text), 'No fonts, imported art, effects or ambiguous stroked bounds');
  const { data, info } = await sharp(Buffer.from(foregroundSvg(paths)), { density: 720 }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, maxRadius = 0, ink = 0;
  const scale = info.width / 108;
  for (let y = 0; y < info.height; y++) for (let x = 0; x < info.width; x++) {
    if (data[(y * info.width + x) * 4 + 3] < 128) continue;
    const px = (x + .5) / scale, py = (y + .5) / scale;
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
    maxRadius = Math.max(maxRadius, Math.hypot(px - 54, py - 54));
    ink++;
  }
  assert.ok(ink > 0, 'Foreground must not be empty');
  assert.ok(maxRadius <= 33, `Critical mark exceeds 66dp safe circle: radius ${maxRadius}`);
  assert.ok(maxX - minX >= 46 && maxX - minX <= 54, 'Two-window silhouette needs a strong, centered width');
  assert.ok(maxY - minY >= 44 && maxY - minY <= 50, 'Two-window silhouette needs a strong, centered height');
  assert.ok(Math.abs((minX + maxX) / 2 - 54) < 1, 'Horizontal optical center');
  assert.ok(Math.abs((minY + maxY) / 2 - 54) < 1, 'Vertical optical center');
});

test('icon: API26 adaptive resources reproduce the source without changing existing identifiers or colors', () => {
  const { paths } = source();
  const foreground = xml(read('android/res/drawable/ic_launcher_foreground.xml'));
  const attr = key => `{${ns}}${key}`;
  assert.equal(foreground[0].tag, 'vector');
  for (const dimension of ['width', 'height']) assert.equal(foreground[0].attrs[attr(dimension)], '108dp');
  for (const dimension of ['viewportWidth', 'viewportHeight']) assert.equal(foreground[0].attrs[attr(dimension)], '108');
  const vectorPaths = foreground.filter(n => n.tag === 'path');
  assert.equal(vectorPaths.length, 2, 'Adaptive foreground must contain both linked window rails');
  vectorPaths.forEach((p, index) => {
    assert.equal(p.attrs[attr('pathData')], paths[index].attrs.d, 'Android and SVG geometry must be identical');
    assert.equal(p.attrs[attr('fillColor')].toLowerCase(), paths[index].attrs.fill.toLowerCase());
    assert.ok(!p.attrs[attr('strokeWidth')], 'Use unambiguous filled contours');
  });
  const adaptive = xml(read('android/res/mipmap-anydpi-v26/ic_launcher.xml'));
  assert.equal(adaptive[0].tag, 'adaptive-icon');
  assert.equal(adaptive.find(n => n.tag === 'background').attrs[attr('drawable')], '@color/icon_background');
  assert.equal(adaptive.find(n => n.tag === 'foreground').attrs[attr('drawable')], '@drawable/ic_launcher_foreground');
  assert.ok(!adaptive.some(n => n.tag === 'monochrome'), 'API26 resource must not depend on API33 tags');
  const colors = xml(read('android/res/values/colors.xml'));
  assert.equal(colors.find(n => n.attrs.name === 'icon_background').text.trim(), '#121814');
  const manifest = xml(read('android/AndroidManifest.xml'));
  const app = manifest.find(n => n.tag === 'application');
  assert.equal(app.attrs[attr('icon')], '@mipmap/ic_launcher');
  assert.equal(app.attrs[attr('roundIcon')], '@mipmap/ic_launcher');

});

test('icon: API33 themed icon uses the same safe silhouette without a filled background', () => {
  assert.ok(exists('android/res/mipmap-anydpi-v33/ic_launcher.xml'), 'API33 adaptive icon with monochrome layer is missing');
  assert.ok(exists('android/res/drawable/ic_launcher_monochrome.xml'), 'Themed foreground vector is missing');
  const attr = key => `{${ns}}${key}`;
  const adaptive = xml(read('android/res/mipmap-anydpi-v33/ic_launcher.xml'));
  assert.equal(adaptive[0].tag, 'adaptive-icon');
  assert.equal(adaptive.find(n => n.tag === 'background').attrs[attr('drawable')], '@color/icon_background');
  assert.equal(adaptive.find(n => n.tag === 'foreground').attrs[attr('drawable')], '@drawable/ic_launcher_foreground');
  assert.equal(adaptive.find(n => n.tag === 'monochrome').attrs[attr('drawable')], '@drawable/ic_launcher_monochrome');
  const monochrome = xml(read('android/res/drawable/ic_launcher_monochrome.xml'));
  assert.equal(monochrome[0].tag, 'vector');
  assert.equal(monochrome[0].attrs[attr('viewportWidth')], '108');
  assert.equal(monochrome[0].attrs[attr('viewportHeight')], '108');
  const rails = monochrome.filter(n => n.tag === 'path');
  assert.equal(rails.length, 2, 'Themed icon must not add a solid-background path');
  rails.forEach((rail, index) => {
    assert.equal(rail.attrs[attr('pathData')], source().paths[index].attrs.d);
    assert.equal(rail.attrs[attr('fillColor')].toLowerCase(), '#ffffff');
  });
});

test('icon: production-vector previews preserve every rail under square, circle and squircle masks at 24–512px', async () => {
  assert.ok(exists('verification/icon-preview.cjs'), 'Reproducible Android-vector preview renderer is missing');
  const rendered = spawnSync(process.execPath, ['verification/icon-preview.cjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(rendered.status, 0, rendered.stderr);
  const manifest = JSON.parse(read('verification/icon-previews.json'));
  assert.deepEqual(manifest.adaptiveViewport, { x: 18, y: 18, size: 72, layerSize: 108 });
  assert.equal(manifest.geometrySource, 'android/res/drawable/ic_launcher_foreground.xml');
  const expected = [24, 32, 48, 64, 128, 512].flatMap(size => ['square', 'circle', 'squircle'].map(mask => `${mask}-${size}`));
  assert.deepEqual(manifest.previews.map(p => `${p.mask}-${p.width}`), expected);
  const crypto = require('node:crypto');
  for (const preview of manifest.previews) {
    const bytes = fs.readFileSync(path.join(root, preview.file));
    assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), preview.sha256, preview.file);
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, preview.width);
    assert.equal(metadata.height, preview.width);
    const { data, info } = await sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const pixel = (x, y) => [...data.subarray((y * info.width + x) * 4, (y * info.width + x) * 4 + 4)];
    assert.equal(pixel(0, 0)[3], preview.mask === 'square' ? 255 : 0);
    assert.equal(pixel(Math.floor(info.width / 2), Math.floor(info.width / 2))[3], 255);
    if (preview.width >= 128) {
      const diagonalAlpha = pixel(Math.floor(info.width * .1), Math.floor(info.width * .1))[3];
      assert.equal(diagonalAlpha, preview.mask === 'circle' ? 0 : 255, 'Mask must match circle vs exponent-4 squircle');
    }
    if (preview.width === 24) {
      let cream = 0, lime = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 200 && data[i + 1] > 200 && data[i + 2] > 190 && data[i + 3] > 200) cream++;
        if (data[i] > 170 && data[i + 1] > 200 && data[i + 2] < 170 && data[i + 3] > 200) lime++;
      }
      assert.ok(cream >= 15 && lime >= 15, `Both rails must remain visible at 24px: cream=${cream}, lime=${lime}`);
    }
  }
  const raw = async mask => sharp(path.join(root, `verification/icon-${mask}-512.png`)).ensureAlpha().raw().toBuffer();
  const square = await raw('square');
  for (const mask of ['circle', 'squircle']) {
    const masked = await raw(mask);
    let checked = 0;
    for (let i = 0; i < square.length; i += 4) {
      if (square[i] === 18 && square[i + 1] === 24 && square[i + 2] === 20) continue;
      assert.deepEqual(masked.subarray(i, i + 4), square.subarray(i, i + 4), `${mask} must not clip any foreground pixel`);
      checked++;
    }
    assert.ok(checked > 1000);
  }
  const sheet = await sharp(path.join(root, 'verification/icon-contact-sheet.png')).metadata();
  assert.equal(sheet.width, 1320);
  assert.equal(sheet.height, 1080);
});
