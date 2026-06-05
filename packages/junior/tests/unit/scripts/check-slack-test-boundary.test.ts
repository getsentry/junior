import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type BoundaryCheckModule = {
  runBoundaryCheck(roots: {
    evalsRoot: string;
    integrationRoot: string;
    mswRoot: string;
    reportRoot: string;
  }): Promise<string[]>;
};

let tempRoot: string;
let runBoundaryCheck: BoundaryCheckModule["runBoundaryCheck"];

async function writeFixtureFile(
  relativePath: string,
  source: string,
): Promise<void> {
  const filePath = path.join(tempRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source, "utf8");
}

async function checkTempRepo(): Promise<string[]> {
  return await runBoundaryCheck({
    evalsRoot: path.join(tempRoot, "packages/junior-evals/evals"),
    integrationRoot: path.join(tempRoot, "packages/junior/tests/integration"),
    mswRoot: path.join(tempRoot, "packages/junior/tests/msw"),
    reportRoot: tempRoot,
  });
}

describe("check-slack-test-boundary", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-boundary-check-"),
    );
    const moduleUrl = new URL(
      "../../../scripts/check-slack-test-boundary.mjs",
      import.meta.url,
    ).href;
    ({ runBoundaryCheck } = (await import(moduleUrl)) as BoundaryCheckModule);
  });

  afterEach(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it("checks eval sources outside the Junior package cwd", async () => {
    await writeFixtureFile(
      "packages/junior-evals/evals/bad.eval.ts",
      'import { queueSlackApiResponse } from "@sentry/junior/tests/msw";\n',
    );

    await expect(checkTempRepo()).resolves.toEqual([
      expect.stringContaining("packages/junior-evals/evals/bad.eval.ts"),
    ]);
  });

  it("detects multiline integration module mocks", async () => {
    await writeFixtureFile(
      "packages/junior/tests/integration/slack/bad.test.ts",
      [
        "import { vi } from 'vitest';",
        "vi.mock(",
        '  "@/chat/respond",',
        "  () => ({})",
        ");",
        "",
      ].join("\n"),
    );

    await expect(checkTempRepo()).resolves.toEqual([
      expect.stringContaining('module mock "@/chat/respond"'),
    ]);
  });
});
