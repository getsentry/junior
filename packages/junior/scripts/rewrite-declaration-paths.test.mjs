import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import {
  rewriteAliasSpecifier,
  rewriteDeclarationSource,
} from "./rewrite-declaration-paths.mjs";

test("rewrites app entry aliases to relative declaration paths", () => {
  const distRoot = "/tmp/junior-dist";
  const fromFile = path.join(distRoot, "app.d.ts");
  assert.equal(
    rewriteAliasSpecifier(fromFile, distRoot, "chat/config"),
    "./chat/config",
  );
  assert.equal(
    rewriteAliasSpecifier(fromFile, distRoot, "handlers/types"),
    "./handlers/types",
  );
});

test("rewrites nested declaration aliases without leaving the package root", () => {
  const distRoot = "/tmp/junior-dist";
  const fromFile = path.join(distRoot, "chat", "config.d.ts");
  assert.equal(
    rewriteAliasSpecifier(fromFile, distRoot, "chat/model-profile"),
    "./model-profile",
  );
  assert.equal(
    rewriteAliasSpecifier(fromFile, distRoot, "handlers/types"),
    "../handlers/types",
  );
});

test("rewrites import and export path aliases in declaration source", () => {
  const distRoot = "/tmp/junior-dist";
  const fromFile = path.join(distRoot, "app.d.ts");
  const source = [
    'import { type BotModelConfig } from "@/chat/config";',
    'export type { ModelProfileInput } from "@/chat/model-profile";',
    'import type { WaitUntilFn } from "@/handlers/types";',
  ].join("\n");

  assert.equal(
    rewriteDeclarationSource(fromFile, distRoot, source),
    [
      'import { type BotModelConfig } from "./chat/config";',
      'export type { ModelProfileInput } from "./chat/model-profile";',
      'import type { WaitUntilFn } from "./handlers/types";',
    ].join("\n"),
  );
});
