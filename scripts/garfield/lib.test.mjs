import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyLanes,
  mergeFindings,
  parseArgs,
  parseFindings,
  packagesForFiles,
  buildValidationCommands,
  laneFileStem,
} from "./lib.mjs";

test("parseArgs keeps repeated flags", () => {
  const args = parseArgs([
    "--goal",
    "ship mvp",
    "--non-goal",
    "rewrite runtime",
    "--non-goal",
    "touch product code",
  ]);
  assert.equal(args.goal, "ship mvp");
  assert.deepEqual(args["non-goal"], [
    "rewrite runtime",
    "touch product code",
  ]);
});

test("classifyLanes core profile skips source-app policies", () => {
  const lanes = classifyLanes(
    [{ path: "packages/junior/src/chat/foo.ts", status: "M" }],
    ["policies/testing.md", "policies/security.md"],
  );
  const byId = Object.fromEntries(lanes.map((lane) => [lane.id, lane]));
  assert.equal(byId["behavior-spec"].status, "applicable");
  assert.equal(byId["repository-instructions"].status, "applicable");
  assert.equal(byId["validation-sufficiency"].status, "applicable");
  assert.equal(byId["type-boundaries"].status, "applicable");
  assert.equal(byId["generated-dependencies"].status, "skipped");
  assert.equal(byId["policy:policies/testing.md"].status, "skipped");
  assert.equal(byId["policy:policies/security.md"].status, "skipped");
  assert.equal(byId["policy:policies/security.md"].modelHint, "cheap");
});

test("classifyLanes full profile opens each source-app policy", () => {
  const lanes = classifyLanes(
    [{ path: "packages/junior/src/chat/foo.ts", status: "M" }],
    ["policies/testing.md", "policies/security.md"],
    { profile: "full" },
  );
  const byId = Object.fromEntries(lanes.map((lane) => [lane.id, lane]));
  assert.equal(byId["policy:policies/testing.md"].status, "applicable");
  assert.equal(byId["policy:policies/security.md"].status, "applicable");
  assert.equal(byId["policy:policies/security.md"].modelHint, "cheap");
});

test("parseFindings accepts none and structured lines", () => {
  assert.deepEqual(parseFindings("none\n", "behavior-spec"), []);
  const findings = parseFindings(
    "[high][evidence:direct path:12;cause:introduced] packages/junior/src/a.ts:12 - leaks null. impact: crash. fix: narrow type.",
    "type-boundaries",
  );
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "high");
  assert.equal(findings[0].laneId, "type-boundaries");
  assert.equal(findings[0].locator, "packages/junior/src/a.ts:12");
  assert.equal(findings[0].valid, true);
});

test("mergeFindings clusters by locator and concern", () => {
  const clusters = mergeFindings([
    {
      laneId: "a",
      severity: "medium",
      evidence: ["direct"],
      locator: "x.ts:1",
      concern: "dup logic",
      impact: "drift",
      fix: "delete copy",
    },
    {
      laneId: "b",
      severity: "high",
      evidence: ["spec"],
      locator: "x.ts:1",
      concern: "Dup logic",
      impact: "drift",
      fix: "delete copy",
    },
  ]);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].severity, "high");
  assert.deepEqual(clusters[0].lanes, ["a", "b"]);
});

test("packagesForFiles reads package names", () => {
  const packages = packagesForFiles(process.cwd(), [
    { path: "packages/junior/src/chat/a.ts", status: "M" },
    { path: "packages/junior-github/src/b.ts", status: "A" },
    { path: "README.md", status: "M" },
  ]);
  assert.ok(packages.includes("@sentry/junior"));
  assert.ok(packages.includes("@sentry/junior-github"));
});

test("buildValidationCommands prefers package filters", () => {
  const commands = buildValidationCommands(["@sentry/junior"]);
  assert.ok(commands.some((item) => item.id === "file-length"));
  assert.ok(
    commands.some(
      (item) => item.command === "pnpm --filter @sentry/junior run typecheck",
    ),
  );
  assert.ok(commands.some((item) => item.id === "skills-check"));
});

test("laneFileStem stabilizes policy ids", () => {
  assert.equal(laneFileStem("behavior-spec"), "behavior-spec");
  assert.equal(
    laneFileStem("policy:policies/testing.md"),
    "policy__policies__testing",
  );
});
