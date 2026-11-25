import packageMetadata from "../package.json" with { type: "json" };

/** Installed Junior package version, or `unknown` when package metadata is unavailable. */
export const JUNIOR_VERSION =
  typeof packageMetadata.version === "string" && packageMetadata.version.trim()
    ? packageMetadata.version
    : "unknown";

/** Git commit that Vercel deployed, or `undefined` outside Vercel. */
export function getDeployedCommit(): string | undefined {
  return process.env["VERCEL_GIT_COMMIT_SHA"]?.trim() || undefined;
}
