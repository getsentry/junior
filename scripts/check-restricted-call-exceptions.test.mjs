import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkRestrictedCallExceptions } from "./check-restricted-call-exceptions.mjs";

const PLUGIN = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../tools/oxlint/junior/index.ts",
);

function writeProject(files, allow) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "restricted-call-check-"));
  const config = {
    overrides: [
      {
        files: ["src/**/*.ts"],
        rules: {
          "junior/restricted-call": [
            "error",
            {
              entries: [
                {
                  module: "src/client",
                  names: ["post"],
                  allow: allow.map((file) => ({ file, reason: "Owner." })),
                  message: "Use the owner.",
                },
              ],
            },
          ],
        },
      },
    ],
  };
  files[".oxlintrc.json"] = JSON.stringify(config);
  for (const [name, contents] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), contents);
  }
  return root;
}

test("reports an owner that exempts no use, a missing owner, and bad disables", async () => {
  const root = writeProject(
    {
      "src/owner.ts": 'import { post } from "./client";\npost();\n',
      "src/stale.ts": "export const clean = 1;\n",
      "src/disables.ts": [
        'import { post } from "./client";',
        "// oxlint-disable-next-line junior/restricted-call",
        "post();",
        "/* oxlint-disable junior/restricted-call -- whole file */",
        "// oxlint-disable-next-line junior/restricted-call -- external API constraint",
        "post();",
        "",
      ].join("\n"),
    },
    ["src/owner.ts", "src/stale.ts", "src/gone.ts"],
  );

  assert.deepEqual(await checkRestrictedCallExceptions(root, PLUGIN), [
    "src/stale.ts is an `allow` owner, but it exempts no use.",
    "src/gone.ts is an `allow` owner, but the file does not exist.",
    "src/disables.ts:2: disables junior/restricted-call without `-next-line` and a ` -- <reason>`.",
    "src/disables.ts:4: disables junior/restricted-call without `-next-line` and a ` -- <reason>`.",
  ]);
});

test("passes when every owner exempts a use", async () => {
  const root = writeProject(
    { "src/owner.ts": 'import { post } from "./client";\npost();\n' },
    ["src/owner.ts"],
  );

  assert.deepEqual(await checkRestrictedCallExceptions(root, PLUGIN), []);
});
