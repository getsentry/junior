import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const juniorRoot = path.resolve(packageRoot, "../junior");
const pluginApiRoot = path.resolve(packageRoot, "../junior-plugin-api");
const nitroBin = path.join(packageRoot, "node_modules", ".bin", "nitro");

function linkPackage(root: string, name: string, target: string): void {
  const linkPath = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, "dir");
}

function writeFixture(root: string): void {
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(root, "nitro.config.ts"),
    `import { defineConfig } from "nitro";
import { juniorNitro } from "@sentry/junior/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [juniorNitro()],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
`,
  );
  fs.writeFileSync(
    path.join(root, "server.ts"),
    `import { createApp, defineJuniorPlugins } from "@sentry/junior";
import { juniorDashboardPlugin } from "@sentry/junior-dashboard";

export default await createApp({
  plugins: defineJuniorPlugins([
    juniorDashboardPlugin({
      authRequired: false,
      allowedGoogleDomains: ["sentry.io"],
    }),
  ]),
});
`,
  );

  linkPackage(root, "nitro", path.join(packageRoot, "node_modules", "nitro"));
  linkPackage(root, "@sentry/junior", juniorRoot);
  linkPackage(root, "@sentry/junior-dashboard", packageRoot);
  linkPackage(root, "@sentry/junior-plugin-api", pluginApiRoot);
}

describe.sequential("dashboard Nitro production output", () => {
  it("serves dashboard routes from the plugin array", async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), "junior-dashboard-output-"),
    );
    const originalCwd = process.cwd();

    try {
      writeFixture(root);
      execFileSync(nitroBin, ["build"], {
        cwd: root,
        env: { ...process.env, CI: "true" },
        stdio: "pipe",
      });

      const functionDir = path.join(
        root,
        ".vercel",
        "output",
        "functions",
        "__server.func",
      );
      process.chdir(functionDir);
      const app = (
        await import(
          `${pathToFileURL(path.join(functionDir, "index.mjs")).href}?t=${Date.now()}`
        )
      ).default as {
        fetch(request: Request, context?: unknown): Promise<Response>;
      };

      const client = await app.fetch(
        new Request("http://localhost/api/dashboard/client.js"),
        {},
      );
      expect(client.status).toBe(200);
      expect(client.headers.get("content-type")).toContain(
        "application/javascript",
      );
      expect(await client.text()).not.toMatch(/\bfrom\s*["']lucide-react["']/);

      const page = await app.fetch(new Request("http://localhost/"), {});
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("dashboard-root");
      expect(html).toContain("bg-black");
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { force: true, recursive: true });
    }
  }, 60_000);
});
