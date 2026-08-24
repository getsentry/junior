import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import {
  rewriteDeclarationText,
  toRelativeImport,
} from "./rewrite-declaration-paths.mjs";

const distRoot = path.join("/pkg", "dist");

describe("rewrite declaration paths", () => {
  it("maps nested @/ imports to relative paths", () => {
    const fromFile = path.join(distRoot, "api", "list.d.ts");
    assert.equal(
      toRelativeImport(fromFile, distRoot, "chat/source"),
      "../chat/source",
    );
  });

  it("rewrites import and export forms in one file", () => {
    const fromFile = path.join(distRoot, "app.d.ts");
    const next = rewriteDeclarationText(
      `
import { type X } from "@/chat/experimental";
export type { Y } from "@/chat/log-context";
export * from "@/chat/plugins/types";
type Z = import("@/chat/runtime/agent-runner").AgentRunner;
`,
      fromFile,
      distRoot,
    );
    assert.equal(
      next.includes("@/"),
      false,
      "no monorepo aliases should remain",
    );
    assert.match(next, /from "\.\/chat\/experimental"/);
    assert.match(next, /import\("\.\/chat\/runtime\/agent-runner"\)/);
  });
});
