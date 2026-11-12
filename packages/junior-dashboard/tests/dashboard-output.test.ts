import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DASHBOARD_CLIENT_ENTRY_NAME,
  DASHBOARD_PUBLIC_ASSET_NAME,
} from "../src/public-assets";

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
  modules: [
    juniorNitro({
      dashboard: {
        authRequired: false,
        allowedDomains: ["sentry.io"],
      },
    }),
  ],
  routes: {
    "/**": { handler: "./server.ts" },
  },
});
`,
  );
  fs.writeFileSync(
    path.join(root, "server.ts"),
    `import { createApp, defineJuniorPlugins } from "@sentry/junior";

const app = await createApp({
  dashboard: {
    authRequired: false,
    allowedDomains: ["sentry.io"],
  },
  plugins: defineJuniorPlugins([]),
});

export default {
  async fetch(request: Request, context?: unknown): Promise<Response> {
    // Like sandbox egress, this route reads the body and can answer 404.
    if (new URL(request.url).pathname === "/read-body-not-found") {
      await request.text();
      return new Response(null, { status: 404 });
    }
    return app.fetch(request, context);
  },
};
`,
  );

  linkPackage(root, "nitro", path.join(packageRoot, "node_modules", "nitro"));
  linkPackage(root, "@sentry/junior", juniorRoot);
  linkPackage(root, "@sentry/junior-dashboard", packageRoot);
  linkPackage(root, "@sentry/junior-plugin-api", pluginApiRoot);
}

describe.sequential("dashboard Nitro production output", () => {
  it("serves dashboard routes from core app config", async () => {
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

      const outputDir = path.join(root, ".vercel", "output");
      const staticAssetsDir = path.join(
        outputDir,
        "static",
        "_junior",
        "dashboard",
        "assets",
      );
      const staticFiles = fs
        .readdirSync(staticAssetsDir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) =>
          path
            .relative(staticAssetsDir, path.join(entry.parentPath, entry.name))
            .split(path.sep)
            .join("/"),
        );
      // Vercel serves these files without the function, cached for a year.
      for (const file of staticFiles) {
        expect(file).toMatch(DASHBOARD_PUBLIC_ASSET_NAME);
      }
      const clientFile = staticFiles.find((file) =>
        DASHBOARD_CLIENT_ENTRY_NAME.test(file),
      );
      expect(clientFile).toBeDefined();

      const routes = (
        JSON.parse(
          fs.readFileSync(path.join(outputDir, "config.json"), "utf8"),
        ) as {
          routes: Array<{
            continue?: boolean;
            dest?: string;
            handle?: string;
            headers?: Record<string, string>;
            src?: string;
          }>;
        }
      ).routes;
      const headerRoute = routes.findIndex(
        (route) =>
          route.src === "/_junior/dashboard/assets(.*)" &&
          route.headers?.["cache-control"] ===
            "public,max-age=31536000,immutable" &&
          route.continue === true,
      );
      const filesystem = routes.findIndex(
        (route) => route.handle === "filesystem",
      );
      const fallback = routes.findIndex(
        (route) => route.src === "/(.*)" && route.dest === "/__server",
      );
      expect(headerRoute).toBeGreaterThanOrEqual(0);
      expect(filesystem).toBeGreaterThan(headerRoute);
      expect(fallback).toBeGreaterThan(filesystem);

      const assetResponse = (file: string) =>
        app.fetch(
          new Request(`http://localhost/_junior/dashboard/assets/${file}`),
          {},
        );
      // Production serves embedded files even when package files are absent.
      const client = await assetResponse(clientFile!);
      expect(client.status).toBe(200);
      expect(client.headers.get("content-type")).toContain(
        "application/javascript",
      );
      const clientScript = await client.text();
      expect(clientScript).toBe(
        fs.readFileSync(path.join(staticAssetsDir, clientFile!), "utf8"),
      );
      expect(clientScript).not.toMatch(/\bfrom\s*["']lucide-react["']/);
      const chunkPaths = [
        ...clientScript.matchAll(/["']\.\/(chunks\/[^"']+\.js)["']/g),
      ].map((match) => match[1]!);
      expect(chunkPaths.length).toBeGreaterThan(0);
      for (const chunkPath of new Set(chunkPaths)) {
        expect(staticFiles).toContain(chunkPath);
        const chunk = await assetResponse(chunkPath);
        expect(chunk.status).toBe(200);
        expect(chunk.headers.get("cache-control")).toBe(
          "public, max-age=31536000, immutable",
        );
      }
      // Binary files are embedded as base64 and must serve their bytes.
      const fontFile = staticFiles.find((file) => file.endsWith(".woff2"));
      expect(fontFile).toBeDefined();
      const font = await assetResponse(fontFile!);
      expect(font.headers.get("content-type")).toBe("font/woff2");
      expect(Buffer.from(await font.arrayBuffer())).toEqual(
        fs.readFileSync(path.join(staticAssetsDir, fontFile!)),
      );
      const missing = await assetResponse("chunks/missing-AAAAAAAA.js");
      expect(missing.status).toBe(404);
      expect(missing.headers.get("cache-control")).toBe("no-store");

      const page = await app.fetch(new Request("http://localhost/"), {});
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain("dashboard-root");
      expect(html).toContain(`src="/_junior/dashboard/assets/${clientFile}"`);

      // Nitro must run server.ts once. A second run would read the used body.
      const notFound = await app.fetch(
        new Request("http://localhost/read-body-not-found", {
          body: "{}",
          method: "POST",
        }),
        {},
      );
      expect(notFound.status).toBe(404);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(root, { force: true, recursive: true });
    }
  }, 60_000);
});
