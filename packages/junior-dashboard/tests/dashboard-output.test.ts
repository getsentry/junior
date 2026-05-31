import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = path.resolve(import.meta.dirname, "..");
const nitroBin = path.join(packageRoot, "node_modules", ".bin", "nitro");

function linkPackage(root: string, name: string, target: string): void {
  const linkPath = path.join(root, "node_modules", ...name.split("/"));
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  fs.symlinkSync(target, linkPath, "dir");
}

function dashboardOutputAsset(functionDir: string, fileName: string): string {
  return path.join(
    functionDir,
    "node_modules",
    "@sentry",
    "junior-dashboard",
    "dist",
    fileName,
  );
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
import { juniorDashboardNitro } from "@sentry/junior-dashboard/nitro";

export default defineConfig({
  preset: "vercel",
  modules: [
    juniorDashboardNitro({
      authRequired: false,
      allowedGoogleDomains: ["sentry.io"],
    }),
  ],
});
`,
  );

  linkPackage(root, "nitro", path.join(packageRoot, "node_modules", "nitro"));
  linkPackage(root, "@sentry/junior-dashboard", packageRoot);
}

describe.sequential("dashboard Nitro production output", () => {
  it("serves dashboard assets from the Vercel function cwd", async () => {
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
      expect(
        fs.existsSync(dashboardOutputAsset(functionDir, "client.js")),
      ).toBe(true);
      const css = fs.readFileSync(
        dashboardOutputAsset(functionDir, "tailwind.css"),
        "utf8",
      );
      expect(css.length).toBeGreaterThan(0);

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

      const page = await app.fetch(new Request("http://localhost/"), {});
      expect(page.status).toBe(200);
      expect(await page.text()).toContain(css.slice(0, 80));
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { force: true, recursive: true });
    }
  }, 60_000);
});
