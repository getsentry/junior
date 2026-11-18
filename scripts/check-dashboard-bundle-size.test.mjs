import assert from "node:assert/strict";
import test from "node:test";
import zlib from "node:zlib";
import {
  compareBundleSizes,
  measureShells,
} from "./check-dashboard-bundle-size.mjs";

test("sums the gzip size of each shell's entry and static imports", () => {
  const files = {
    "classic-a.js": Buffer.from("classic"),
    "inbox-b.js": Buffer.from("inbox"),
    "chunks/shared-c.js": Buffer.from("shared ".repeat(50)),
  };
  const gzip = (file) => zlib.gzipSync(files[file]).length;
  const sizes = measureShells(
    {
      shells: {
        classic: { entry: "classic-a.js", imports: ["chunks/shared-c.js"] },
        inbox: { entry: "inbox-b.js", imports: [] },
      },
    },
    (file) => files[file],
  );
  assert.deepEqual(sizes, {
    classic: gzip("classic-a.js") + gzip("chunks/shared-c.js"),
    inbox: gzip("inbox-b.js"),
  });
});

test("passes growth within the limit and any shrink", () => {
  const { lines, errors } = compareBundleSizes({
    baseline: { classic: 100_000, inbox: 100_000 },
    sizes: { classic: 102_000, inbox: 90_000 },
  });
  assert.deepEqual(errors, []);
  assert.deepEqual(lines, [
    "classic: 97.7 KB -> 99.6 KB gzip (+2.0 KB, +2.00%)",
    "inbox: 97.7 KB -> 87.9 KB gzip (-9.8 KB, -10.00%)",
  ]);
});

test("rejects growth over the limit and a shell with no baseline", () => {
  const { errors } = compareBundleSizes({
    baseline: { classic: 100_000 },
    sizes: { classic: 102_001, inbox: 1_000 },
  });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /^classic: grew 2\.00%, over the 2% limit\./);
  assert.match(errors[0], /--update/);
  assert.match(errors[1], /^inbox: no baseline entry\./);
});
