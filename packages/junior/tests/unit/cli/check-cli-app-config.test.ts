import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCheckCliTempRoots,
  makeTempDir,
  writeFile,
  expectCheckFailure,
  mkdir,
  runCheckAndCollect,
} from "../../fixtures/check-cli";

afterEach(cleanupCheckCliTempRoots);

describe("check cli app config", () => {
  it("fails when app source uses the removed pluginPackages option", async () => {
    const repoRoot = makeTempDir("junior-validate-plugin-packages-option-");
    writeFile(
      path.join(repoRoot, "server.ts"),
      [
        'import { createApp } from "@sentry/junior";',
        "",
        "export default await createApp({",
        '  pluginPackages: ["@acme/junior-demo"],',
        "});",
        "",
      ].join("\n"),
    );

    const lines = await expectCheckFailure(
      repoRoot,
      "Validation failed (1 error, 0 plugin manifests, 0 skill directories checked).",
    );

    expect(
      lines.some((line) =>
        line.includes(
          "pluginPackages is no longer supported. Export a defineJuniorPlugins(...) set",
        ),
      ),
    ).toBe(true);
  });

  it("fails when app source uses the removed plugins.packages option", async () => {
    const repoRoot = makeTempDir("junior-validate-plugins-packages-option-");
    writeFile(
      path.join(repoRoot, "nitro.config.ts"),
      [
        'import { juniorNitro } from "@sentry/junior/nitro";',
        "",
        "export default {",
        "  modules: [",
        "    juniorNitro({",
        "      plugins: { packages: ['@acme/junior-demo'] },",
        "    }),",
        "  ],",
        "};",
        "",
      ].join("\n"),
    );

    const lines = await expectCheckFailure(
      repoRoot,
      "Validation failed (1 error, 0 plugin manifests, 0 skill directories checked).",
    );

    expect(
      lines.some((line) =>
        line.includes(
          "plugins.packages is no longer supported. Export a defineJuniorPlugins(...) set",
        ),
      ),
    ).toBe(true);
  });

  it("fails when app configDefaults references an unregistered plugin key", async () => {
    const repoRoot = makeTempDir("junior-validate-config-defaults-");
    writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@acme/junior-demo": "1.0.0",
          },
        },
        null,
        2,
      ),
    );
    const packageRoot = path.join(
      repoRoot,
      "node_modules",
      "@acme",
      "junior-demo",
    );
    writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "@acme/junior-demo", version: "1.0.0" }),
    );
    writeFile(
      path.join(packageRoot, "plugin.yaml"),
      [
        "name: demo",
        "description: Demo packaged plugin",
        "config-keys:",
        "  - org",
        "",
      ].join("\n"),
    );
    writeFile(
      path.join(repoRoot, "server.ts"),
      [
        'import { createApp } from "@sentry/junior";',
        "",
        "export default await createApp({",
        "  configDefaults: {",
        '    "sentry.org": "sentry",',
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    const lines = await expectCheckFailure(
      repoRoot,
      "Validation failed (1 error, 1 plugin manifest, 0 skill directories checked).",
    );

    expect(
      lines.some((line) =>
        line.includes(
          'configDefaults key "sentry.org" is not a registered plugin config key',
        ),
      ),
    ).toBe(true);
  });

  it("skips app file validation for unrelated app directories", async () => {
    const repoRoot = makeTempDir("junior-validate-empty-app-");
    mkdir(path.join(repoRoot, "app"));

    const lines = await runCheckAndCollect(repoRoot);

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      "✓ Validation passed (0 plugin manifests, 0 skill directories checked).",
    ]);
  });
});
