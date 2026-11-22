import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

/**
 * Gzip budget for the dashboard first load. Each UI shell loads its entry and
 * every file that the entry imports statically, as listed in
 * `dist/client-manifest.json`. The baseline follows `main`:
 *
 * - The measured size of a shell must match the committed baseline within
 *   `NOISE_BYTES`. A change that grows the first load commits the new size.
 * - The committed baseline of a shell may grow at most 2% (`GROWTH_LIMIT`)
 *   over the baseline at the merge base with `origin/main`, so the limit
 *   applies to each change. CI needs the full history for the merge base.
 * - A shell that shrinks passes. Update the baseline to tighten it.
 *
 * It reads the last dashboard build and does not build:
 *
 *   pnpm --filter "@sentry/junior-dashboard..." run build
 *   pnpm dashboard-bundle-size:check
 *
 * Update the baseline in the change that grows or shrinks the first load:
 *
 *   pnpm dashboard-bundle-size:check --update
 *
 * When two open changes both grow it, the second to merge must merge `main`
 * and run `--update` again.
 */

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const DASHBOARD_DIST = "packages/junior-dashboard/dist";
const MANIFEST_PATH = `${DASHBOARD_DIST}/client-manifest.json`;
const BASELINE_PATH = "scripts/dashboard-bundle-size-baseline.json";
const BASE_BRANCH = "origin/main";
const UPDATE_COMMAND = "pnpm dashboard-bundle-size:check --update";

// CI runs this check in its own job, after the dashboard build.
export const lint = false;
const GROWTH_LIMIT = 0.02;
// Two clean builds of one commit give the same bytes, and CI prints the same
// sizes as a local build. The tolerance covers zlib output that can differ
// across platforms. It is far below the growth limit (about 13 KB per shell).
const NOISE_BYTES = 1024;

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

function change(from, to) {
  const delta = to - from;
  const sign = delta >= 0 ? "+" : "-";
  const percent = Math.abs((delta / from) * 100).toFixed(2);
  return `${sign}${kb(Math.abs(delta))}, ${sign}${percent}%`;
}

/**
 * Compare measured shell sizes with the committed baseline, and the committed
 * baseline with the baseline at the merge base. Returns one diff line per
 * shell, hints to tighten the baseline, and errors.
 */
export function compareBundleSizes({ base, baseline, sizes }) {
  const lines = [];
  const hints = [];
  const errors = [];
  for (const [shell, actual] of Object.entries(sizes)) {
    const committed = baseline[shell];
    if (committed === undefined) {
      lines.push(`${shell}: ${kb(actual)} gzip, no baseline`);
      errors.push(`${shell}: no baseline entry. Run \`${UPDATE_COMMAND}\`.`);
      continue;
    }
    const before = base[shell];
    lines.push(
      [
        `${shell}:`,
        ...(before === undefined
          ? []
          : [
              `main ${kb(before)} -> baseline ${kb(committed)} (${change(before, committed)}),`,
            ]),
        `measured ${kb(actual)} gzip (${change(committed, actual)} vs baseline)`,
      ].join(" "),
    );
    if (actual > committed + NOISE_BYTES) {
      errors.push(
        `${shell}: ${actual - committed} B over the committed baseline. Run \`${UPDATE_COMMAND}\` and commit the baseline.`,
      );
    } else if (actual < committed - NOISE_BYTES) {
      hints.push(
        `${shell}: ${committed - actual} B under the committed baseline. Run \`${UPDATE_COMMAND}\` to tighten it.`,
      );
    }
    if (before !== undefined && committed > before * (1 + GROWTH_LIMIT)) {
      errors.push(
        `${shell}: the baseline grew ${(((committed - before) / before) * 100).toFixed(2)}% over ${BASE_BRANCH}, over the ${GROWTH_LIMIT * 100}% limit for one change. Load the new code lazily, or keep it out of the first load.`,
      );
    }
  }
  return { lines, hints, errors };
}

function git(args) {
  return execFileSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: "pipe",
  });
}

// The committed baseline at the merge base with main, or no entries when the
// file is new there.
function readBaseBaseline() {
  let base;
  try {
    base = git(["merge-base", "HEAD", BASE_BRANCH]).trim();
  } catch (error) {
    throw new Error(
      `${BASE_BRANCH} has no merge base with HEAD. Run \`git fetch origin main\`, and use the full history in CI.`,
      { cause: error },
    );
  }
  try {
    return JSON.parse(git(["show", `${base}:${BASELINE_PATH}`]));
  } catch {
    return {};
  }
}

/** Compare dashboard shell sizes to the baseline, or rewrite it with `--update`. */
export function run({ args }) {
  const manifestPath = path.join(REPO_ROOT, MANIFEST_PATH);
  if (!fs.existsSync(manifestPath)) {
    return [
      `${MANIFEST_PATH} is missing. Build the dashboard first: pnpm --filter "@sentry/junior-dashboard..." run build`,
    ];
  }
  const sizes = measureShells(
    JSON.parse(fs.readFileSync(manifestPath, "utf8")),
    (file) =>
      fs.readFileSync(path.join(REPO_ROOT, DASHBOARD_DIST, "public", file)),
  );
  const baselinePath = path.join(REPO_ROOT, BASELINE_PATH);
  if (args.includes("--update")) {
    fs.writeFileSync(baselinePath, `${JSON.stringify(sizes, null, 2)}\n`);
    console.log(`Wrote ${BASELINE_PATH}:`);
    for (const [shell, bytes] of Object.entries(sizes)) {
      console.log(`${shell}: ${kb(bytes)} gzip`);
    }
    return [];
  }
  const { lines, hints, errors } = compareBundleSizes({
    base: readBaseBaseline(),
    baseline: JSON.parse(fs.readFileSync(baselinePath, "utf8")),
    sizes,
  });
  console.log([...lines, ...hints].join("\n"));
  return errors;
}
