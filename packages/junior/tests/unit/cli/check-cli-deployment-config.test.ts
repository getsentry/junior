import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCheckCliTempRoots,
  makeTempDir,
  writeFile,
  expectCheckFailure,
  runCheckAndCollect,
} from "../../fixtures/check-cli";

afterEach(cleanupCheckCliTempRoots);

describe("check cli deployment config", () => {
  it("fails when a Junior Nitro app does not install juniorNitro", async () => {
    const repoRoot = makeTempDir("junior-validate-missing-nitro-module-");
    writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@sentry/junior": "1.0.0",
          },
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(repoRoot, "nitro.config.ts"),
      [
        'import { defineConfig } from "nitro";',
        "",
        "export default defineConfig({",
        '  preset: "vercel",',
        "});",
        "",
      ].join("\n"),
    );

    const lines = await expectCheckFailure(
      repoRoot,
      "Validation failed (1 error, 0 plugin manifests, 0 skill directories checked).",
    );

    expect(lines).toContain("✖ deployment config");
    expect(
      lines.some((line) =>
        line.includes(
          "missing juniorNitro(). The Nitro module emits Junior's Vercel queue trigger and heartbeat cron",
        ),
      ),
    ).toBe(true);
  });

  it("fails when Vercel config targets the legacy queue source file", async () => {
    const repoRoot = makeTempDir("junior-validate-legacy-vercel-function-");
    writeFile(
      path.join(repoRoot, "vercel.json"),
      JSON.stringify(
        {
          framework: "nitro",
          functions: {
            "api/internal/agent/continue.ts": {
              maxDuration: 300,
              experimentalTriggers: [
                {
                  type: "queue/v2beta",
                  topic: "junior_conversation_work",
                },
              ],
            },
          },
        },
        null,
        2,
      ),
    );

    const lines = await expectCheckFailure(
      repoRoot,
      "Validation failed (1 error, 0 plugin manifests, 0 skill directories checked).",
    );

    expect(lines).toContain("✖ deployment config");
    expect(
      lines.some((line) =>
        line.includes(
          "functions.api/internal/agent/continue.ts targets a source file that Nitro does not deploy",
        ),
      ),
    ).toBe(true);
  });

  it("warns when Vercel config still declares the root heartbeat cron", async () => {
    const repoRoot = makeTempDir("junior-validate-root-heartbeat-cron-");
    writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@sentry/junior": "1.0.0",
          },
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(repoRoot, "nitro.config.ts"),
      [
        'import { defineConfig } from "nitro";',
        'import { juniorNitro } from "@sentry/junior/nitro";',
        "",
        "export default defineConfig({",
        '  preset: "vercel",',
        "  modules: [juniorNitro()],",
        "});",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(repoRoot, "vercel.json"),
      JSON.stringify(
        {
          framework: "nitro",
          crons: [
            {
              path: "/api/internal/heartbeat",
              schedule: "* * * * *",
            },
          ],
        },
        null,
        2,
      ),
    );

    const lines = await runCheckAndCollect(repoRoot);

    expect(lines).toContain("⚠ deployment config");
    expect(
      lines.some((line) =>
        line.includes(
          "/api/internal/heartbeat cron is now emitted by juniorNitro()",
        ),
      ),
    ).toBe(true);
  });

  it("skips deployment config validation for unrelated Vercel projects", async () => {
    const repoRoot = makeTempDir("junior-validate-unrelated-vercel-");
    writeFile(path.join(repoRoot, "vercel.json"), "{ invalid");

    const lines = await runCheckAndCollect(repoRoot);

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      "✓ Validation passed (0 plugin manifests, 0 skill directories checked).",
    ]);
  });
});
