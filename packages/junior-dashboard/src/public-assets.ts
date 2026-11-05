import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dashboardClientFile, dashboardPublicAssets } from "./assets";

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

/**
 * Name the dashboard client entry. Without embedded assets, read the build
 * output on each call, so a client rebuild never leaves the page on a deleted
 * file.
 */
export function dashboardClientFileName(): string {
  if (dashboardClientFile) return dashboardClientFile;
  const dir = publicDir();
  // A watch rebuild can leave older entries next to the new one.
  const newest = dir
    ? readdirSync(dir)
        .filter((file) => DASHBOARD_CLIENT_ENTRY_NAME.test(file))
        .map((file) => ({
          file,
          mtimeMs: statSync(path.join(dir, file)).mtimeMs,
        }))
        .sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
    : undefined;
  if (!newest) {
    throw new Error("Junior dashboard client bundle was not found");
  }
  return newest.file;
}

function readPublicAsset(file: string): string | undefined {
  if (!DASHBOARD_PUBLIC_ASSET_NAME.test(file)) return undefined;
  if (Object.hasOwn(dashboardPublicAssets, file)) {
    return dashboardPublicAssets[file];
  }
  // An embedded build has every file it can serve.
  if (dashboardClientFile) return undefined;
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
