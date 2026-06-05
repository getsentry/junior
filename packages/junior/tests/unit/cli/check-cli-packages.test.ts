import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cleanupCheckCliTempRoots,
  makeTempDir,
  writeFile,
  mkdir,
  runCheckAndCollect,
} from "../../fixtures/check-cli";

afterEach(cleanupCheckCliTempRoots);

describe("check cli packaged plugins", () => {
  it("accepts configDefaults from JS-defined packaged plugin manifests", async () => {
    const repoRoot = makeTempDir("junior-validate-js-plugin-defaults-");
    writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@acme/junior-github": "1.0.0",
            "@acme/junior-sentry": "1.0.0",
          },
        },
        null,
        2,
      ),
    );
    const githubPackageRoot = path.join(
      repoRoot,
      "node_modules",
      "@acme",
      "junior-github",
    );
    writeFile(
      path.join(githubPackageRoot, "package.json"),
      JSON.stringify({
        name: "@acme/junior-github",
        version: "1.0.0",
        type: "module",
        exports: { ".": { default: "./index.js" } },
      }),
    );
    writeFile(
      path.join(githubPackageRoot, "index.js"),
      [
        "export function githubPlugin() {",
        "  return {",
        '    name: "github",',
        "    manifest: {",
        '      name: "github",',
        '      description: "GitHub plugin",',
        '      configKeys: ["org", "repo"],',
        "    },",
        "  };",
        "}",
        "",
      ].join("\n"),
    );
    mkdir(path.join(githubPackageRoot, "skills"));

    const sentryPackageRoot = path.join(
      repoRoot,
      "node_modules",
      "@acme",
      "junior-sentry",
    );
    writeFile(
      path.join(sentryPackageRoot, "package.json"),
      JSON.stringify({ name: "@acme/junior-sentry", version: "1.0.0" }),
    );
    writeFile(
      path.join(sentryPackageRoot, "plugin.yaml"),
      [
        "name: sentry",
        "description: Sentry plugin",
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
        '    "github.org": "getsentry",',
        '    "sentry.org": "sentry",',
        "  },",
        "});",
        "",
      ].join("\n"),
    );

    const lines = await runCheckAndCollect(repoRoot);

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      "✓ packaged plugin github (@acme/junior-github)",
      "✓ packaged plugin sentry (@acme/junior-sentry)",
      "✓ Validation passed (2 plugin manifests, 0 skill directories checked).",
    ]);
  });

  it("warns when official plugin package versions differ from core", async () => {
    const repoRoot = makeTempDir("junior-validate-version-skew-");
    writeFile(
      path.join(repoRoot, "package.json"),
      JSON.stringify(
        {
          dependencies: {
            "@sentry/junior": "^0.43.0",
            "@sentry/junior-github": "^0.42.0",
          },
        },
        null,
        2,
      ),
    );
    writeFile(
      path.join(repoRoot, "node_modules", "@sentry", "junior", "package.json"),
      JSON.stringify({ name: "@sentry/junior", version: "0.43.0" }),
    );
    writeFile(
      path.join(
        repoRoot,
        "node_modules",
        "@sentry",
        "junior-github",
        "package.json",
      ),
      JSON.stringify({ name: "@sentry/junior-github", version: "0.42.0" }),
    );
    mkdir(
      path.join(repoRoot, "node_modules", "@sentry", "junior-github", "skills"),
    );

    const lines = await runCheckAndCollect(repoRoot);

    expect(lines).toEqual([
      `Checking ${repoRoot}`,
      `⚠ warning: ${path.join(repoRoot, "package.json")}: @sentry/junior-github version 0.42.0 does not match @sentry/junior version 0.43.0`,
      "✓ Validation passed (0 plugin manifests, 0 skill directories checked).",
    ]);
  });
});
