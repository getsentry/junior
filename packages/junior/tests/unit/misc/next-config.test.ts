import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NextConfig } from "next";
import { describe, expect, it } from "vitest";
import { withJunior } from "@/next-config";

async function resolveConfig(
  config:
    | NextConfig
    | ((
        phase: string,
        ctx: { defaultConfig: NextConfig },
      ) => Promise<NextConfig> | NextConfig),
): Promise<NextConfig> {
  if (typeof config === "function") {
    return await config("phase-production-build", { defaultConfig: {} });
  }

  return config;
}

describe("withJunior", () => {
  it("merges junior defaults into plain Next config", async () => {
    const config = await resolveConfig(
      withJunior(
        {
          dataDir: "./my-data",
          skillsDir: "./my-skills",
          pluginsDir: "./my-plugins",
        },
        {
          serverExternalPackages: ["existing-package"],
        },
      ) as NextConfig,
    );

    expect(config.serverExternalPackages).toEqual(
      expect.arrayContaining([
        "existing-package",
        "@vercel/queue",
        "@vercel/sandbox",
        "bash-tool",
        "just-bash",
        "@mariozechner/pi-agent-core",
        "@mariozechner/pi-ai",
        "@chat-adapter/slack",
        "@slack/web-api",
      ]),
    );
    expect(config.outputFileTracingIncludes?.["/*"]).toEqual(
      expect.arrayContaining([
        "./my-data/**/*",
        "./my-skills/**/*",
        "./my-plugins/**/*",
      ]),
    );
    expect(config.env?.JUNIOR_PLUGIN_PACKAGES).toBe("[]");
  });

  it("wraps async Next config factories", async () => {
    const wrapped = withJunior(
      {
        dataDir: "./my-data",
        skillsDir: "./my-skills",
        pluginsDir: "./my-plugins",
      },
      async () => ({
        typedRoutes: true,
      }),
    );

    expect(typeof wrapped).toBe("function");
    if (typeof wrapped !== "function") {
      throw new Error("Expected withJunior to return a config factory");
    }

    const resolved = await resolveConfig(wrapped);

    expect(resolved.typedRoutes).toBe(true);
    expect(resolved.outputFileTracingIncludes?.["/*"]).toEqual(
      expect.arrayContaining([
        "./my-data/**/*",
        "./my-skills/**/*",
        "./my-plugins/**/*",
      ]),
    );
    expect(resolved.serverExternalPackages).toEqual(
      expect.arrayContaining([
        "@vercel/queue",
        "@vercel/sandbox",
        "bash-tool",
        "just-bash",
        "@mariozechner/pi-agent-core",
        "@mariozechner/pi-ai",
        "@chat-adapter/slack",
        "@slack/web-api",
      ]),
    );
  });

  it("merges existing global tracing includes instead of overwriting them", async () => {
    const config = await resolveConfig(
      withJunior(
        {
          dataDir: "./my-data",
          skillsDir: "./my-skills",
          pluginsDir: "./my-plugins",
        },
        {
          outputFileTracingIncludes: {
            "/*": ["./existing/**/*"],
            "/other/**": ["./other/**/*"],
          },
        },
      ) as NextConfig,
    );

    expect(config.outputFileTracingIncludes?.["/*"]).toEqual(
      expect.arrayContaining([
        "./existing/**/*",
        "./my-data/**/*",
        "./my-skills/**/*",
        "./my-plugins/**/*",
      ]),
    );
    expect(config.outputFileTracingIncludes?.["/other/**"]).toEqual([
      "./other/**/*",
    ]);
  });

  it("deduplicates serverExternalPackages when consumer already includes defaults", async () => {
    const config = await resolveConfig(
      withJunior(
        {
          dataDir: "./my-data",
          skillsDir: "./my-skills",
          pluginsDir: "./my-plugins",
        },
        {
          serverExternalPackages: [
            "@vercel/queue",
            "@vercel/sandbox",
            "custom-package",
          ],
        },
      ) as NextConfig,
    );

    expect(config.serverExternalPackages).toEqual(
      expect.arrayContaining([
        "@vercel/queue",
        "@vercel/sandbox",
        "bash-tool",
        "just-bash",
        "@mariozechner/pi-agent-core",
        "@mariozechner/pi-ai",
        "@chat-adapter/slack",
        "@slack/web-api",
        "custom-package",
      ]),
    );
    expect(
      config.serverExternalPackages?.filter((pkg) => pkg === "@vercel/queue"),
    ).toHaveLength(1);
    expect(
      config.serverExternalPackages?.filter((pkg) => pkg === "@vercel/sandbox"),
    ).toHaveLength(1);
  });

  it("preserves consumer transpilePackages", async () => {
    const config = await resolveConfig(
      withJunior(
        {},
        {
          transpilePackages: ["other-package"],
        },
      ) as NextConfig,
    );

    expect(config.transpilePackages).toEqual(["other-package"]);
  });

  it("accepts pre-wrapped configs without changing behavior", async () => {
    const config = await resolveConfig(
      withJunior({}, { typedRoutes: true }) as NextConfig,
    );

    expect(config.typedRoutes).toBe(true);
    expect(config.transpilePackages).toBeUndefined();
  });

  it("does not auto-include installed dependency plugin content without explicit pluginPackages", async () => {
    const originalCwd = process.cwd();
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-next-config-"),
    );

    try {
      await fs.writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({
          name: "temp-app",
          private: true,
          dependencies: {
            "@acme/junior-plugin-demo": "1.0.0",
          },
        }),
        "utf8",
      );
      await fs.mkdir(
        path.join(
          tempRoot,
          "node_modules",
          "@acme",
          "junior-plugin-demo",
          "skills",
          "demo",
        ),
        {
          recursive: true,
        },
      );
      await fs.mkdir(
        path.join(
          tempRoot,
          "node_modules",
          "@acme",
          "junior-plugin-demo",
          "plugins",
        ),
        {
          recursive: true,
        },
      );
      await fs.writeFile(
        path.join(
          tempRoot,
          "node_modules",
          "@acme",
          "junior-plugin-demo",
          "plugin.yaml",
        ),
        "name: demo\ndescription: Demo plugin\ncapabilities:\n  - api\nconfig-keys: []\ncredentials:\n  type: oauth-bearer\n  api-domains:\n    - api.example.com\n  auth-token-env: DEMO_TOKEN\n",
        "utf8",
      );

      process.chdir(tempRoot);
      const config = await resolveConfig(withJunior({}) as NextConfig);

      expect(config.outputFileTracingIncludes?.["/*"]).not.toEqual(
        expect.arrayContaining([
          "./node_modules/@acme/junior-plugin-demo/plugin.yaml",
          "./node_modules/@acme/junior-plugin-demo/plugins/**/*",
          "./node_modules/@acme/junior-plugin-demo/skills/**/*",
        ]),
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("does not auto-include node_modules plugin content without explicit pluginPackages", async () => {
    const originalCwd = process.cwd();
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-next-config-"),
    );

    try {
      await fs.writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({
          name: "temp-app",
          private: true,
        }),
        "utf8",
      );
      await fs.mkdir(
        path.join(
          tempRoot,
          "node_modules",
          "@acme",
          "junior-plugin-demo",
          "skills",
          "demo",
        ),
        {
          recursive: true,
        },
      );
      await fs.writeFile(
        path.join(
          tempRoot,
          "node_modules",
          "@acme",
          "junior-plugin-demo",
          "plugin.yaml",
        ),
        "name: demo\ndescription: Demo plugin\n",
        "utf8",
      );

      process.chdir(tempRoot);
      const config = await resolveConfig(withJunior({}) as NextConfig);

      expect(config.outputFileTracingIncludes?.["/*"]).not.toEqual(
        expect.arrayContaining([
          "./node_modules/@acme/junior-plugin-demo/plugin.yaml",
          "./node_modules/@acme/junior-plugin-demo/skills/**/*",
        ]),
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("accepts explicit pluginPackages option", async () => {
    const originalCwd = process.cwd();
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-next-config-"),
    );

    try {
      await fs.writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({
          name: "temp-app",
          private: true,
        }),
        "utf8",
      );
      await fs.mkdir(
        path.join(
          tempRoot,
          "node_modules",
          "@acme",
          "junior-plugin-explicit",
          "skills",
          "demo",
        ),
        {
          recursive: true,
        },
      );
      await fs.writeFile(
        path.join(
          tempRoot,
          "node_modules",
          "@acme",
          "junior-plugin-explicit",
          "plugin.yaml",
        ),
        "name: demo\ndescription: Demo plugin\n",
        "utf8",
      );

      process.chdir(tempRoot);
      const config = await resolveConfig(
        withJunior(
          { pluginPackages: ["@acme/junior-plugin-explicit"] },
          {},
        ) as NextConfig,
      );

      expect(config.outputFileTracingIncludes?.["/*"]).toEqual(
        expect.arrayContaining([
          "./node_modules/@acme/junior-plugin-explicit/plugin.yaml",
          "./node_modules/@acme/junior-plugin-explicit/skills/**/*",
        ]),
      );
      expect(config.env?.JUNIOR_PLUGIN_PACKAGES).toBe(
        JSON.stringify(["@acme/junior-plugin-explicit"]),
      );
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("throws when explicit pluginPackages contains unresolved packages", async () => {
    const originalCwd = process.cwd();
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-next-config-"),
    );

    try {
      await fs.writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({
          name: "temp-app",
          private: true,
        }),
        "utf8",
      );
      process.chdir(tempRoot);

      expect(() =>
        withJunior({ pluginPackages: ["@acme/does-not-exist"] }, {}),
      ).toThrow("withJunior pluginPackages contains unresolved packages");
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("throws when explicit pluginPackages contains installed packages without Junior plugin content", async () => {
    const originalCwd = process.cwd();
    const tempRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "junior-next-config-"),
    );

    try {
      await fs.writeFile(
        path.join(tempRoot, "package.json"),
        JSON.stringify({
          name: "temp-app",
          private: true,
        }),
        "utf8",
      );
      await fs.mkdir(
        path.join(tempRoot, "node_modules", "@acme", "not-a-junior-plugin"),
        {
          recursive: true,
        },
      );
      await fs.writeFile(
        path.join(
          tempRoot,
          "node_modules",
          "@acme",
          "not-a-junior-plugin",
          "package.json",
        ),
        JSON.stringify({ name: "@acme/not-a-junior-plugin", version: "1.0.0" }),
        "utf8",
      );
      process.chdir(tempRoot);

      expect(() =>
        withJunior({ pluginPackages: ["@acme/not-a-junior-plugin"] }, {}),
      ).toThrow("installed packages that are not valid Junior plugins");
    } finally {
      process.chdir(originalCwd);
    }
  });
});
