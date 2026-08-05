import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkToolAnnotationSource } from "./check-tool-annotations.mjs";

describe("checkToolAnnotationSource", () => {
  it("accepts complete behavioral hints", () => {
    const errors = checkToolAnnotationSource(`
      zodTool({
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
      });
    `);

    assert.deepEqual(errors, []);
  });

  it("rejects missing and inconsistent hints", () => {
    const errors = checkToolAnnotationSource(`
      definePluginTool({
        annotations: {
          destructiveHint: true,
          readOnlyHint: true,
        },
      });
    `);

    assert.deepEqual(errors, [
      "tool.ts:2: repo tool annotations missing idempotentHint, openWorldHint",
      "tool.ts:2: read-only tools cannot declare destructiveHint: true",
    ]);
  });

  it("rejects omitted annotations", () => {
    const errors = checkToolAnnotationSource(
      `zodTool({ description: "demo" });`,
    );

    assert.deepEqual(errors, [
      "tool.ts:1: repo tool must declare annotations with destructiveHint, idempotentHint, openWorldHint, readOnlyHint",
    ]);
  });
});
