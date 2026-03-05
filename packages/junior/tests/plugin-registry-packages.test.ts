import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const originalCwd = process.cwd();

async function writePackagedPlugin(tempRoot: string): Promise<void> {
  const packageRoot = path.join(tempRoot, "node_modules", "@acme", "junior-plugin-demo");
  const skillsDir = path.join(packageRoot, "skills", "demo");
  await fs.mkdir(skillsDir, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "plugin.yaml"),
    [
      "name: demo",
      "description: Demo plugin",
      "capabilities:",
      "  - api",
      "config-keys:",
      "  - org",
      "credentials:",
      "  type: oauth-bearer",
      "  api-domains:",
      "    - api.example.com",
      "  auth-token-env: DEMO_AUTH_TOKEN"
    ].join("\n"),
    "utf8"
  );
}

afterEach(() => {
  process.chdir(originalCwd);
  vi.resetModules();
  vi.doUnmock("@/chat/home");
});

describe("plugin registry package discovery", () => {
  it("loads plugins from installed npm dependencies", async () => {
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "junior-plugin-package-"));
    await writePackagedPlugin(tempRoot);
    await fs.writeFile(
      path.join(tempRoot, "package.json"),
      JSON.stringify({
        name: "temp-junior-app",
        private: true,
        dependencies: {
          "@acme/junior-plugin-demo": "1.0.0"
        }
      }),
      "utf8"
    );
    process.chdir(tempRoot);

    vi.resetModules();
    vi.doMock("@/chat/home", () => ({
      pluginRoots: () => []
    }));

    const registry = await import("@/chat/plugins/registry");
    const providers = registry.getPluginProviders();
    expect(providers).toHaveLength(1);
    expect(providers[0]?.manifest.name).toBe("demo");
    expect(providers[0]?.manifest.capabilities).toEqual(["demo.api"]);
    expect(registry.getPluginSkillRoots()).toEqual([
      path.join(tempRoot, "node_modules", "@acme", "junior-plugin-demo", "skills")
    ]);
    expect(registry.isPluginProvider("demo")).toBe(true);
  });
});
