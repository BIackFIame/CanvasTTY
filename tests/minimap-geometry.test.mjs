import assert from "node:assert/strict";
import test from "node:test";
import {
  MINIMAP_SURFACE_SIZE,
  MINIMAP_CONTENT_PADDING,
  cameraWorldViewport,
  minimapCameraForPointerDrag,
  minimapAreaForBounds,
  minimapEdgePointForBounds,
  minimapPointForBounds,
  minimapWorldBounds,
  minimapWorldPoint
} from "../src/renderer/src/features/workspace/minimapGeometry.ts";

const home = {
  position: { x: 0, y: 0 },
  size: { width: 1_582, height: 1_062 }
};
const viewportSize = { width: 1_400, height: 820 };

test("camera pan and zoom change the viewport without rescaling the workspace overview", () => {
  const initialViewport = cameraWorldViewport({ x: 0, y: 0, zoom: 1 }, viewportSize);
  const movedViewport = cameraWorldViewport({ x: -400, y: -200, zoom: 0.75 }, viewportSize);
  const world = minimapWorldBounds([home]);
  const homeArea = minimapAreaForBounds(home, world);
  const initialArea = minimapAreaForBounds(initialViewport, world);
  const movedArea = minimapAreaForBounds(movedViewport, world);

  assert.ok(initialArea && movedArea);
  assert.ok(movedArea.x > initialArea.x);
  assert.ok(movedArea.y > initialArea.y);
  assert.ok(movedArea.width > initialArea.width);
  assert.deepEqual(minimapAreaForBounds(home, world), homeArea);
  assert.ok(Math.abs(initialArea.width * MINIMAP_SURFACE_SIZE.width
    / (initialArea.height * MINIMAP_SURFACE_SIZE.height) - viewportSize.width / viewportSize.height) < 1e-9);
});

test("minimap projection uses one scale for both axes and never stretches objects", () => {
  const world = minimapWorldBounds([home]);
  const worldUnitsPerPixelX = world.size.width / MINIMAP_SURFACE_SIZE.width;
  const worldUnitsPerPixelY = world.size.height / MINIMAP_SURFACE_SIZE.height;
  const square = {
    position: { x: 500, y: 240 },
    size: { width: 240, height: 240 }
  };
  const projected = minimapAreaForBounds(square, world);

  assert.equal(worldUnitsPerPixelX, worldUnitsPerPixelY);
  assert.ok(projected);
  assert.equal(
    Math.round(projected.width * MINIMAP_SURFACE_SIZE.width * 1_000),
    Math.round(projected.height * MINIMAP_SURFACE_SIZE.height * 1_000)
  );
});

test("the viewport edge marker appears only when the camera leaves the overview", () => {
  const world = minimapWorldBounds([home]);
  const partlyVisibleViewport = {
    position: { x: world.position.x + world.size.width - 40, y: 200 },
    size: { width: 200, height: 300 }
  };
  const outsideViewport = {
    position: { x: world.position.x + world.size.width + 80, y: 200 },
    size: { width: 200, height: 300 }
  };

  assert.ok(minimapAreaForBounds(home, world));
  assert.equal(minimapEdgePointForBounds(home, world), null);
  assert.ok(minimapAreaForBounds(partlyVisibleViewport, world));
  assert.equal(minimapEdgePointForBounds(partlyVisibleViewport, world), null);
  assert.equal(minimapAreaForBounds(outsideViewport, world), null);

  const edge = minimapEdgePointForBounds(outsideViewport, world);
  assert.ok(edge);
  assert.equal(edge.x > 0.9, true);
  assert.equal(edge.x < 1, true);
});

test("the overview fits every object including distant windows and negative coordinates", () => {
  const windows = [home,
    { position: { x: -8_000, y: -3_000 }, size: { width: 1_600, height: 900 } },
    { position: { x: 12_000, y: 4_000 }, size: { width: 800, height: 450 } }
  ];
  const world = minimapWorldBounds(windows);
  const marginX = MINIMAP_CONTENT_PADDING / MINIMAP_SURFACE_SIZE.width;
  const marginY = MINIMAP_CONTENT_PADDING / MINIMAP_SURFACE_SIZE.height;
  for (const bounds of windows) {
    const area = minimapAreaForBounds(bounds, world);
    assert.ok(area);
    assert.ok(area.x >= marginX - 1e-9 && area.y >= marginY - 1e-9);
    assert.ok(area.x + area.width <= 1 - marginX + 1e-9);
    assert.ok(area.y + area.height <= 1 - marginY + 1e-9);
  }
  const large = minimapAreaForBounds(windows[1], world);
  const small = minimapAreaForBounds(windows[2], world);
  assert.equal(large.width, small.width * 2);
  assert.equal(large.height, small.height * 2);
});

test("layout changes expand and shrink the overview around occupied bounds", () => {
  const distant = { position: { x: 10_000, y: 0 }, size: { width: 1_000, height: 600 } };
  const expanded = minimapWorldBounds([home, distant]);
  const restored = minimapWorldBounds([home]);
  assert.ok(expanded.size.width > restored.size.width);
  assert.deepEqual(restored, minimapWorldBounds([home]));
  const resized = minimapWorldBounds([{ ...home, size: { width: 4_000, height: 3_000 } }]);
  assert.ok(resized.size.height > restored.size.height);
});

test("viewport rectangles retain their true geometry when clipped by the map surface", () => {
  const world = minimapWorldBounds([home]);
  const viewport = {
    position: { x: world.position.x - 100, y: world.position.y + 100 },
    size: { width: 400, height: 300 }
  };
  const area = minimapAreaForBounds(viewport, world);
  assert.ok(area);
  assert.ok(area.x < 0);
  assert.equal(area.width, 400 / world.size.width);
});

test("an empty overview has a finite projection and map clicks recover world coordinates", () => {
  const empty = minimapWorldBounds([]);
  assert.ok(empty.size.width > 0 && Number.isFinite(empty.size.width));
  assert.ok(empty.size.height > 0 && Number.isFinite(empty.size.height));
  const world = minimapWorldBounds([home]);
  const center = minimapWorldPoint(minimapPointForBounds(home, world), world);
  assert.ok(Math.abs(center.x - home.size.width / 2) < 1e-9);
  assert.ok(Math.abs(center.y - home.size.height / 2) < 1e-9);
});

test("minimap drag follows the same grab direction as empty-canvas drag", () => {
  const camera = { x: 100, y: 200, zoom: 0.5 };
  const pointerDelta = { x: 17.2, y: 10.4 };
  const surfaceSize = { width: 172, height: 104 };
  const worldBounds = {
    position: { x: -500, y: -300 },
    size: { width: 1_720, height: 1_040 }
  };

  assert.equal(
    minimapCameraForPointerDrag("click", camera, pointerDelta, surfaceSize, worldBounds),
    null
  );
  const dragged = minimapCameraForPointerDrag("drag", camera, pointerDelta, surfaceSize, worldBounds);
  assert.ok(dragged);
  assert.equal(Math.abs(dragged.x - 186) < 1e-9, true);
  assert.equal(Math.abs(dragged.y - 252) < 1e-9, true);
  assert.equal(dragged.zoom, 0.5);
});
