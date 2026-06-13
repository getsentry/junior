import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

type BoundaryCheckModule = {
  runTestBoundaryCheck(roots: {
    evalsRoot: string;
    evalTestsRoot: string;
    integrationRoot: string;
    mswRoot: string;
    reportRoot: string;
    testRoot: string;
  }): Promise<string[]>;
};

let tempRoot: string;
let runTestBoundaryCheck: BoundaryCheckModule["runTestBoundaryCheck"];

async function writeFixtureFile(
  relativePath: string,
  source: string,
): Promise<void> {
  const filePath = path.join(tempRoot, relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, source, "utf8");
}

function viModuleMockSource(
  kind: "doMock" | "mock",
  moduleName: string,
  factory: string,
): string {
  return `vi.${kind}("${moduleName}", ${factory});`;
}

function expectCalledSource(name: string): string {
  return `expect(${name}).toHaveBeenCalled();`;
}

async function checkTempRepo(): Promise<string[]> {
  return await runTestBoundaryCheck({
    evalsRoot: path.join(tempRoot, "packages/junior-evals/evals"),
    evalTestsRoot: path.join(tempRoot, "packages/junior-evals/tests"),
    integrationRoot: path.join(tempRoot, "packages/junior/tests/integration"),
    mswRoot: path.join(tempRoot, "packages/junior/tests/msw"),
    reportRoot: tempRoot,
    testRoot: path.join(tempRoot, "packages/junior/tests"),
  });
}

describe("check-test-boundaries", () => {
  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-boundary-check-"),
    );
    const moduleUrl = new URL(
      "../../../scripts/check-test-boundaries.mjs",
      import.meta.url,
    ).href;
    ({ runTestBoundaryCheck } = (await import(
      moduleUrl
    )) as BoundaryCheckModule);
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

  it("rejects eval imports of raw Slack capture wrappers", async () => {
    await writeFixtureFile(
      "packages/junior-evals/evals/bad-capture.eval.ts",
      [
        'import { readCapturedSlackApiCalls } from "@junior-tests/msw/captured-slack-api-calls";',
        "readCapturedSlackApiCalls();",
        "",
      ].join("\n"),
    );

    await expect(checkTempRepo()).resolves.toEqual([
      expect.stringContaining("readCapturedSlackApiCalls"),
      expect.stringContaining("captured-slack-api-calls"),
    ]);
  });

  it("rejects legacy flat eval override keys", async () => {
    await writeFixtureFile(
      "packages/junior-evals/evals/bad-overrides.eval.ts",
      [
        "await run({",
        "  overrides: {",
        "    reply_texts: ['ok'],",
        "    plugin_dirs: ['evals/fixtures/plugins'],",
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    const violations = await checkTempRepo();
    expect(violations).toHaveLength(2);
    expect(violations).toEqual([
      expect.stringContaining("plugin_dirs"),
      expect.stringContaining("reply_texts"),
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

  it("detects observability module mocks outside instrumentation tests", async () => {
    await writeFixtureFile(
      "packages/junior/tests/unit/tools/bad.test.ts",
      [
        "import { vi } from 'vitest';",
        viModuleMockSource(
          "mock",
          "@/chat/logging",
          "() => ({ logWarn: vi.fn() })",
        ),
        "",
      ].join("\n"),
    );

    await expect(checkTempRepo()).resolves.toEqual([
      expect.stringContaining('observability module mock "@/chat/logging"'),
    ]);
  });

  it("allows observability mocks in dedicated logging contract tests", async () => {
    await writeFixtureFile(
      "packages/junior/tests/unit/logging/tool-span.test.ts",
      [
        "import { vi } from 'vitest';",
        viModuleMockSource(
          "mock",
          "@/chat/logging",
          "() => ({ withSpan: vi.fn() })",
        ),
        "",
      ].join("\n"),
    );

    await expect(checkTempRepo()).resolves.toEqual([]);
  });

  it("rejects observability mocks in feature-local instrumentation tests", async () => {
    await writeFixtureFile(
      "packages/junior/tests/unit/tools/tool-instrumentation.test.ts",
      [
        "import { vi } from 'vitest';",
        viModuleMockSource(
          "mock",
          "@/chat/logging",
          "() => ({ withSpan: vi.fn() })",
        ),
        "",
      ].join("\n"),
    );

    await expect(checkTempRepo()).resolves.toEqual([
      expect.stringContaining("tests/unit/tools/tool-instrumentation.test.ts"),
    ]);
  });

  it("allows Sentry client config mocks that do not replace capture or span helpers", async () => {
    await writeFixtureFile(
      "packages/junior/tests/unit/slack/footer-sentry-link.test.ts",
      [
        "import { vi } from 'vitest';",
        viModuleMockSource(
          "doMock",
          "@/chat/sentry",
          "() => ({ getClient: () => ({ getDsn: () => undefined }) })",
        ),
        "",
      ].join("\n"),
    );

    await expect(checkTempRepo()).resolves.toEqual([]);
  });

  it("detects observability assertions outside instrumentation tests", async () => {
    await writeFixtureFile(
      "packages/junior/tests/unit/tools/bad-assertion.test.ts",
      [
        "import { expect, vi } from 'vitest';",
        "const logWarn = vi.fn();",
        expectCalledSource("logWarn"),
        "",
      ].join("\n"),
    );

    await expect(checkTempRepo()).resolves.toEqual([
      expect.stringContaining("Forbidden observability assertion"),
    ]);
  });
});
