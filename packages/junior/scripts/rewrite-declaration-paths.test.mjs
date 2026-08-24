import assert from "node:assert/strict";
import { describe, it } from "node:test";
import path from "node:path";
import {
  rewriteAliasSpecifier,
  rewriteDeclarationSource,
} from "./rewrite-declaration-paths.mjs";

const distRoot = path.join("/pkg", "dist");

describe("rewriteAliasSpecifier", () => {
  it("rewrites nested declaration imports to relative paths", () => {
    const fromFile = path.join(distRoot, "api", "conversations", "list.d.ts");
    assert.equal(
      rewriteAliasSpecifier(fromFile, distRoot, "@/chat/source"),
      "../../chat/source",
    );
  });

  it("keeps a leading ./ for same-tree roots", () => {
    const fromFile = path.join(distRoot, "app.d.ts");
    assert.equal(
      rewriteAliasSpecifier(fromFile, distRoot, "@/chat/experimental"),
      "./chat/experimental",
    );
  });

  it("leaves non-alias specifiers alone", () => {
    const fromFile = path.join(distRoot, "app.d.ts");
    assert.equal(
      rewriteAliasSpecifier(fromFile, distRoot, "./plugins"),
      "./plugins",
    );
  });
});

describe("rewriteDeclarationSource", () => {
  it("rewrites import, export, and dynamic import aliases", () => {
    const fromFile = path.join(distRoot, "app.d.ts");
    const source = `
import { type ExperimentalFeaturesConfig } from "@/chat/experimental";
export type { LogContext } from "@/chat/log-context";
export * from "@/chat/plugins/types";
type Runner = import("@/chat/runtime/agent-runner").AgentRunner;
`;
    const next = rewriteDeclarationSource(source, fromFile, distRoot);
    assert.match(next, /from "\.\/chat\/experimental"/);
    assert.match(next, /from "\.\/chat\/log-context"/);
    assert.match(next, /from "\.\/chat\/plugins\/types"/);
    assert.match(next, /import\("\.\/chat\/runtime\/agent-runner"\)/);
    assert.doesNotMatch(next, /@\//);
  });
});
