import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

/**
 * Gzip budget for the dashboard first load. Each UI shell loads its entry and
 * every file that the entry imports statically, as listed in
 * `dist/client-manifest.json`. The check fails when a shell grows more than
 * 2% (`GROWTH_LIMIT`) over the committed baseline. It reads the last dashboard
 * build and does not build:
 *
 *   pnpm --filter "@sentry/junior-dashboard..." run build
 *   pnpm dashboard-bundle-size:check
 *
 * When a change must grow the first load, update the baseline in that change:
 *
 *   node scripts/check-dashboard-bundle-size.mjs --update
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DASHBOARD_DIST = "packages/junior-dashboard/dist";
const MANIFEST_PATH = `${DASHBOARD_DIST}/client-manifest.json`;
const BASELINE_PATH = "scripts/dashboard-bundle-size-baseline.json";
const UPDATE_COMMAND = "node scripts/check-dashboard-bundle-size.mjs --update";
const GROWTH_LIMIT = 0.02;

/** Sum the gzip bytes of each shell's entry and its static imports. */
export function measureShells(manifest, readPublicFile) {
  return Object.fromEntries(
    Object.entries(manifest.shells).map(([shell, files]) => [
      shell,
      [files.entry, ...files.imports].reduce(
        (total, file) => total + zlib.gzipSync(readPublicFile(file)).length,
        0,
      ),
    ]),
  );
}

function kb(bytes) {
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Compare shell sizes with the baseline. Returns one diff line per shell, and
 * an error for each shell that grew past the limit or has no baseline.
 */
export function compareBundleSizes({ baseline, sizes }) {
  const lines = [];
  const errors = [];
  for (const [shell, actual] of Object.entries(sizes)) {
    const allowed = baseline[shell];
    if (allowed === undefined) {
      lines.push(`${shell}: ${kb(actual)} gzip, no baseline`);
      errors.push(`${shell}: no baseline entry. Run \`${UPDATE_COMMAND}\`.`);
      continue;
    }
    const delta = actual - allowed;
    const percent = (delta / allowed) * 100;
    const sign = delta >= 0 ? "+" : "-";
    lines.push(
      `${shell}: ${kb(allowed)} -> ${kb(actual)} gzip (${sign}${kb(Math.abs(delta))}, ${sign}${Math.abs(percent).toFixed(2)}%)`,
    );
    if (actual > allowed * (1 + GROWTH_LIMIT)) {
      errors.push(
        `${shell}: grew ${percent.toFixed(2)}%, over the ${GROWTH_LIMIT * 100}% limit. Load the new code lazily, or keep it out of the first load. If the growth is intended, run \`${UPDATE_COMMAND}\` and commit the baseline.`,
      );
    }
  }
  return { lines, errors };
}

function main() {
  const manifestPath = path.join(REPO_ROOT, MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) {
    console.error(
      `${MANIFEST_PATH} is missing. Build the dashboard first: pnpm --filter "@sentry/junior-dashboard..." run build`,
    );
    process.exitCode = 1;
    return;
  }
  const sizes = measureShells(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    (file) =>
      fs.readFileSync(path.join(REPO_ROOT, DASHBOARD_DIST, "public", file)),
  );
  const baselinePath = path.join(REPO_ROOT, BASELINE_PATH);
  if (process.argv.includes("--update")) {
    fs.writeFileSync(baselinePath, `${JSON.stringify(sizes, null, 2)}\n`);
    console.log(`Wrote ${BASELINE_PATH}:`);
    for (const [shell, bytes] of Object.entries(sizes)) {
      console.log(`${shell}: ${kb(bytes)} gzip`);
    }
    return;
  }
  const { lines, errors } = compareBundleSizes({
    baseline: JSON.parse(fs.readFileSync(baselinePath, "utf8")),
    sizes,
  });
  console.log(lines.join("\n"));
  if (errors.length > 0) {
    console.error(
      ["Dashboard bundle size check failed:", ...errors].join("\n"),
    );
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
