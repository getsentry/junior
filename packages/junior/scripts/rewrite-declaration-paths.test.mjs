import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { rewriteDeclarationText } from "./rewrite-declaration-paths.mjs";

test("rewrites declaration module specifiers as ESM paths", async (t) => {
  const distRoot = await fs.mkdtemp(path.join(os.tmpdir(), "junior-dts-"));
  t.after(() => fs.rm(distRoot, { recursive: true, force: true }));

  await fs.mkdir(path.join(distRoot, "chat"), { recursive: true });
  await fs.mkdir(path.join(distRoot, "plugins"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(distRoot, "chat/config.d.ts"), ""),
    fs.writeFile(path.join(distRoot, "chat/model.d.ts"), ""),
    fs.writeFile(path.join(distRoot, "plugins/index.d.ts"), ""),
  ]);

  const fromFile = path.join(distRoot, "nested/public.d.ts");
  const source = `import type { Config } from "@/chat/config";
export { plugin } from "../plugins";
type Model = import("@/chat/model").Model;
export type { Ready } from "../ready.js";
type Literal = "@/chat/config";
`;
  const rewritten = rewriteDeclarationText(source, fromFile, distRoot);

  assert.equal(rewritten.rewrittenSpecifiers, 3);
  assert.equal(
    rewritten.output,
    `import type { Config } from "../chat/config.js";
export { plugin } from "../plugins/index.js";
type Model = import("../chat/model.js").Model;
export type { Ready } from "../ready.js";
type Literal = "@/chat/config";
`,
  );
});

test("rejects an alias without an emitted declaration", async (t) => {
  const distRoot = await fs.mkdtemp(path.join(os.tmpdir(), "junior-dts-"));
  t.after(() => fs.rm(distRoot, { recursive: true, force: true }));

  assert.throws(
    () =>
      rewriteDeclarationText(
        `export type { Missing } from "@/missing";`,
        path.join(distRoot, "public.d.ts"),
        distRoot,
      ),
    /has no emitted target/,
  );
});
