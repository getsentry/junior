import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  collectToolErrorThrows,
  diffToolErrorBaseline,
  parseBaseline,
} from "./check-tool-error-classification.mjs";

describe("check-tool-error-classification", () => {
  it("collects plain Error throws and ignores expected tool errors", () => {
    const signatures = collectToolErrorThrows(
      `
        throw new Error("system failure");
        throw new ToolInputError("bad input");
        throw new PluginToolInputError("missing target");
        throw new TypeError("wrong class");
      `,
      "packages/junior/src/chat/tools/demo.ts",
    );

    assert.deepEqual(signatures, [
      'packages/junior/src/chat/tools/demo.ts\tthrow new Error("system failure");',
    ]);
  });

  it("flags new throws and stale baseline entries", () => {
    const { unexpected, stale } = diffToolErrorBaseline(
      [
        'packages/junior/src/chat/tools/a.ts\tthrow new Error("kept");',
        'packages/junior/src/chat/tools/b.ts\tthrow new Error("new");',
      ],
      parseBaseline(`
# comment
packages/junior/src/chat/tools/a.ts\tthrow new Error("kept");
packages/junior/src/chat/tools/c.ts\tthrow new Error("gone");
`),
    );

    assert.deepEqual(unexpected, [
      'packages/junior/src/chat/tools/b.ts\tthrow new Error("new");',
    ]);
    assert.deepEqual(stale, [
      'packages/junior/src/chat/tools/c.ts\tthrow new Error("gone");',
    ]);
  });
});
