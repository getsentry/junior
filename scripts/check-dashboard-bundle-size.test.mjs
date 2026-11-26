import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import {
  compareBundleSizes,
  measureFirstLoad,
} from "./check-dashboard-bundle-size.mjs";

test("sums the gzip size of the entry and its static imports", () => {
  const files = {
    "dashboard-a.js": Buffer.from("dashboard"),
    "chunks/shared-c.js": Buffer.from("shared ".repeat(50)),
  };
  const gzip = (file) => zlib.gzipSync(files[file]).length;
  const sizes = measureFirstLoad(
    { entry: "dashboard-a.js", imports: ["chunks/shared-c.js"] },
    (file) => files[file],
  );
  assert.deepEqual(sizes, {
    dashboard: gzip("dashboard-a.js") + gzip("chunks/shared-c.js"),
  });
});

const MAIN = { dashboard: 100_000 };

function compare(baseline, measured, base = MAIN) {
  return compareBundleSizes({
    base,
    baseline: { dashboard: baseline },
    sizes: { dashboard: measured },
  });
}

test("passes a build within the noise tolerance of the baseline", () => {
  const { lines, hints, errors } = compare(100_000, 100_500);
  assert.deepEqual(errors, []);
  assert.deepEqual(hints, []);
  assert.deepEqual(lines, [
    "dashboard: main 97.7 KB -> baseline 97.7 KB (+0.0 KB, +0.00%), measured 98.1 KB gzip (+0.5 KB, +0.50% vs baseline)",
  ]);
});

test("rejects growth that the baseline does not commit", () => {
  const { errors } = compare(100_000, 101_500);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /^dashboard: 1500 B over the committed baseline\./);
  assert.match(errors[0], /--update/);
});

test("passes growth that the baseline commits within 2% of main", () => {
  assert.deepEqual(compare(102_000, 102_000).errors, []);
});

test("rejects a baseline that grows more than 2% over main", () => {
  const { errors } = compare(102_001, 102_001);
  assert.equal(errors.length, 1);
  assert.match(
    errors[0],
    /^dashboard: the baseline grew 2\.00% over origin\/main, over the 2% limit/,
  );
});

test("passes a shrink and hints to tighten the baseline", () => {
  const { hints, errors } = compare(100_000, 90_000);
  assert.deepEqual(errors, []);
  assert.equal(hints.length, 1);
  assert.match(hints[0], /^dashboard: 10000 B under the committed baseline\./);
});

test("rejects a shell with no baseline, and skips main when it has none", () => {
  const { lines, errors } = compareBundleSizes({
    base: {},
    baseline: { dashboard: 100_000 },
    sizes: { dashboard: 100_000, inbox: 1_000 },
  });
  assert.deepEqual(errors, [
    "inbox: no baseline entry. Run `pnpm dashboard-bundle-size:check --update`.",
  ]);
  assert.match(lines[0], /^dashboard: measured 97\.7 KB gzip/);
});
