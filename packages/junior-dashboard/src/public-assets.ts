import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as z from "zod";
import { dashboardClientManifest, dashboardPublicAssets } from "./assets";

/**
 * URL prefix for the content-hashed dashboard browser files. `juniorNitro()`
 * also serves `dist/public` here as immutable static assets, so every file
 * under this prefix must have a content hash in its name.
 */
export const DASHBOARD_ASSETS_PATH = "/_junior/dashboard/assets";

/** Path under the assets prefix of a content-hashed browser file. */
export const DASHBOARD_PUBLIC_ASSET_NAME =
  /^(?:chunks\/)?[A-Za-z0-9_-]+-[A-Z0-9]{8}\.js$/;

/** File name of the content-hashed dashboard browser entry. */
export const DASHBOARD_CLIENT_ENTRY_NAME = /^client-[A-Z0-9]{8}\.js$/;

// Builds embed these files. Without them (tests and local development from
// source), read the client build output from disk.
function publicDir(): string | undefined {
  return [
    fileURLToPath(new URL("../dist/public", import.meta.url)),
    path.join(
      process.cwd(),
      "node_modules",
      "@sentry",
      "junior-dashboard",
      "dist",
      "public",
    ),
  ].find((dir) => existsSync(dir));
}

/** File under `dist` where the client build names its entry and imports. */
export const DASHBOARD_CLIENT_MANIFEST_FILE = "client-manifest.json";

/** The client entry and every file it imports statically. */
export const dashboardClientManifestSchema = z.object({
  entry: z.string().regex(DASHBOARD_CLIENT_ENTRY_NAME),
  imports: z.array(z.string().regex(DASHBOARD_PUBLIC_ASSET_NAME)),
});

/** The dashboard client entry and every file it imports statically. */
export type DashboardClientManifest = z.infer<
  typeof dashboardClientManifestSchema
>;

/**
 * Read the client manifest. Without embedded assets, read the build output on
 * each call, so a client rebuild never leaves the page on a deleted file.
 */
export function readDashboardClientManifest(): DashboardClientManifest {
  if (dashboardClientManifest) return dashboardClientManifest;
  const dir = publicDir();
  const manifestPath =
    dir && path.join(dir, "..", DASHBOARD_CLIENT_MANIFEST_FILE);
  if (!manifestPath || !existsSync(manifestPath)) {
    throw new Error("Junior dashboard client bundle was not found");
  }
  return dashboardClientManifestSchema.parse(
    JSON.parse(readFileSync(manifestPath, "utf8")),
  );
}

function readPublicAsset(file: string): string | undefined {
  if (!DASHBOARD_PUBLIC_ASSET_NAME.test(file)) return undefined;
  if (Object.hasOwn(dashboardPublicAssets, file)) {
    return dashboardPublicAssets[file];
  }
  // An embedded build has every file it can serve.
  if (dashboardClientManifest) return undefined;
  const dir = publicDir();
  const assetPath = dir ? path.join(dir, file) : undefined;
  return assetPath && existsSync(assetPath)
    ? readFileSync(assetPath, "utf8")
    : undefined;
}

/**
 * Serve one content-hashed dashboard browser file. An unknown name gets a 404
 * that no cache keeps, so an older deployment's files still load after a
 * rollback.
 */
export function dashboardPublicAssetResponse(file: string): Response {
  const body = readPublicAsset(file);
  if (body === undefined) {
    return new Response("Not Found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
  return new Response(body, {
    headers: {
      "cache-control": "public, max-age=31536000, immutable",
      "content-type": "application/javascript; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}
