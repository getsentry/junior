import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const checkerPath = path.resolve(import.meta.dirname, "check-skills.mjs");

test("validates repository skills when the packages directory is unavailable", async (t) => {
  const workspaceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "junior-check-skills-"),
  );
  t.after(() => fs.rm(workspaceRoot, { recursive: true, force: true }));

  const checkerCwd = path.join(workspaceRoot, "tooling", "checker");
  const skillDir = path.join(workspaceRoot, "skills", "example");
  await fs.mkdir(checkerCwd, { recursive: true });
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(path.join(workspaceRoot, "pnpm-workspace.yaml"), "");
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    "---\nname: wrong-name\ndescription: Example skill.\n---\nInstructions.\n",
  );

  const result = spawnSync(process.execPath, [checkerPath], {
    cwd: checkerCwd,
    encoding: "utf8",
  });

  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
});
