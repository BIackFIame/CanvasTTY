import assert from "node:assert/strict";
import test from "node:test";
import {
  INSTALLED_PAGE_SIZE,
  SHOWCASE_PAGE_SIZE,
  clampPage,
  pageCount,
  paginate,
  unresolvedPageUrls
} from "../src/renderer/src/features/plugins/pluginPagination.ts";

// Plugin stubs: id/name only — the test only cares about the array.
function makePlugins(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `com.test.plugin-${i + 1}`,
    name: `Plugin ${i + 1}`
  }));
}

// Showcase/search result stubs: url + fullName only — what unresolvedPageUrls reads.
function makeResults(count) {
  return Array.from({ length: count }, (_, i) => ({
    url: `https://github.com/example/plugin-${i + 1}`,
    fullName: `example/plugin-${i + 1}`
  }));
}

test("installed page size is 6", () => {
  assert.equal(INSTALLED_PAGE_SIZE, 6);
});

test("showcase page size is 10", () => {
  assert.equal(SHOWCASE_PAGE_SIZE, 10);
});

test("pageCount computes ceiling for exact and partial pages", () => {
  assert.equal(pageCount(0, 6), 0);
  assert.equal(pageCount(6, 6), 1);
  assert.equal(pageCount(7, 6), 2);
  assert.equal(pageCount(12, 6), 2);
  assert.equal(pageCount(13, 6), 3);
  assert.equal(pageCount(10, 10), 1);
  assert.equal(pageCount(11, 10), 2);
});

test("pageCount guards invalid input", () => {
  assert.equal(pageCount(-1, 6), 0);
  assert.equal(pageCount(5, 0), 0);
  assert.equal(pageCount(Number.NaN, 6), 0);
  assert.equal(pageCount(5, Number.POSITIVE_INFINITY), 0);
});

test("clampPage stays in range", () => {
  assert.equal(clampPage(0, 0, 6), 0);
  assert.equal(clampPage(0, 6, 6), 0);
  assert.equal(clampPage(1, 6, 6), 0); // 6 items = 1 page, page 1 clamps to 0
  assert.equal(clampPage(1, 12, 6), 1);
  assert.equal(clampPage(5, 12, 6), 1); // out of range → last
  assert.equal(clampPage(-3, 12, 6), 0);
  assert.equal(clampPage(Number.NaN, 12, 6), 0);
});

test("installed plugins: 6 fit one page, 7 split into two pages", () => {
  const six = paginate(makePlugins(6), 0, INSTALLED_PAGE_SIZE);
  assert.equal(six.length, 6);

  const seven = makePlugins(7);
  const p0 = paginate(seven, 0, INSTALLED_PAGE_SIZE);
  const p1 = paginate(seven, 1, INSTALLED_PAGE_SIZE);
  assert.equal(p0.length, 6);
  assert.equal(p1.length, 1);
  assert.equal(p0[0].id, "com.test.plugin-1");
  assert.equal(p1[0].id, "com.test.plugin-7");
  // The first page does not contain items from the second page.
  assert.ok(!p0.some((item) => item.id === "com.test.plugin-7"));
});

test("installed plugins: many stubs paginate without overlap or loss", () => {
  const many = makePlugins(25);
  const pages = [0, 1, 2, 3, 4].map((page) => paginate(many, page, INSTALLED_PAGE_SIZE));
  const ids = pages.flat().map((item) => item.id);
  assert.equal(ids.length, 25);
  assert.equal(new Set(ids).size, 25); // no duplicates
  assert.equal(pageCount(25, INSTALLED_PAGE_SIZE), 5);
});

test("showcase plugins: 10 fit one page, 11 split into two pages", () => {
  const ten = paginate(makePlugins(10), 0, SHOWCASE_PAGE_SIZE);
  assert.equal(ten.length, 10);

  const eleven = makePlugins(11);
  const p0 = paginate(eleven, 0, SHOWCASE_PAGE_SIZE);
  const p1 = paginate(eleven, 1, SHOWCASE_PAGE_SIZE);
  assert.equal(p0.length, 10);
  assert.equal(p1.length, 1);
  assert.equal(p1[0].id, "com.test.plugin-11");
});

test("showcase plugins: many stubs paginate without overlap or loss", () => {
  const many = makePlugins(37);
  const count = pageCount(37, SHOWCASE_PAGE_SIZE);
  assert.equal(count, 4);
  const pages = Array.from({ length: count }, (_, i) => paginate(many, i, SHOWCASE_PAGE_SIZE));
  const ids = pages.flat().map((item) => item.id);
  assert.equal(ids.length, 37);
  assert.equal(new Set(ids).size, 37); // no duplicates, no loss
});

test("paginate returns [] for empty or invalid input", () => {
  assert.deepEqual(paginate([], 0, 6), []);
  assert.deepEqual(paginate(makePlugins(3), 0, 0), []);
  assert.deepEqual(paginate(null, 0, 6), []);
});

test("unresolvedPageUrls: fetches only the current page's urls, not the full result set", () => {
  const results = makeResults(37); // more than one showcase page (10 per page)
  const urls = unresolvedPageUrls(results, 0, SHOWCASE_PAGE_SIZE, new Set());
  assert.equal(urls.length, SHOWCASE_PAGE_SIZE, "only the visible page's urls are requested");
  assert.deepEqual(urls, results.slice(0, SHOWCASE_PAGE_SIZE).map((r) => r.url));

  // A later page still asks only for its own slice — never the other 27 items.
  const page3 = unresolvedPageUrls(results, 3, SHOWCASE_PAGE_SIZE, new Set());
  assert.equal(page3.length, 7); // 37 - 3*10
});

test("unresolvedPageUrls: skips items already resolved (cached), even mid-page", () => {
  const results = makeResults(10);
  const resolved = new Set([results[0].fullName, results[3].fullName, results[9].fullName]);
  const urls = unresolvedPageUrls(results, 0, SHOWCASE_PAGE_SIZE, resolved);
  assert.equal(urls.length, 7);
  assert.ok(!urls.includes(results[0].url));
  assert.ok(!urls.includes(results[3].url));
  assert.ok(!urls.includes(results[9].url));

  // Once every item on the page is resolved, nothing more is fetched for it.
  const allResolved = new Set(results.map((r) => r.fullName));
  assert.deepEqual(unresolvedPageUrls(results, 0, SHOWCASE_PAGE_SIZE, allResolved), []);
});

test("unresolvedPageUrls: returns [] for empty results or an out-of-range page beyond the last", () => {
  assert.deepEqual(unresolvedPageUrls([], 0, SHOWCASE_PAGE_SIZE, new Set()), []);
  const results = makeResults(5);
  // clampPage folds an out-of-range page back into range, so this still returns the (only) page's urls,
  // not [] — paginate/clampPage's own contract, which unresolvedPageUrls must not change.
  assert.deepEqual(
    unresolvedPageUrls(results, 99, SHOWCASE_PAGE_SIZE, new Set()),
    results.map((r) => r.url)
  );
});
