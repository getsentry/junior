import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Page } from "@playwright/test";
import { mockDashboardApis, startDashboardE2eServer } from "../e2e/harness.ts";
import {
  resolveVisualScenarios,
  selectVisualScenarioIds,
  VISUAL_ALL_LABEL,
  type VisualScenario,
  type VisualScenarioPrepare,
  type VisualViewport,
} from "./scenarios.ts";

const FOCUSED_COMPOSER_VISUAL_HEIGHT_PX = 520;
const FOCUSED_COMPOSER_VISUAL_OFFSET_TOP_PX = 140;

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const DEFAULT_OUT_DIR = path.join(ROOT, ".playwright/visual-dashboard");

type CaptureShot = {
  file: string;
  label: string;
};

type CaptureManifest = {
  commitSha: string | null;
  mode: "all" | "explicit" | "path";
  reasons: string[];
  scenarioIds: string[];
  shots: CaptureShot[];
  skipped: boolean;
};

function requireFlagValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.trim() === "" || value.startsWith("-")) {
    throw new Error(`${flag} requires a non-empty value`);
  }
  return value;
}

function parseArgs(argv: string[]) {
  let all = false;
  let changedFile: string | undefined;
  let outDir = DEFAULT_OUT_DIR;
  let scenarioCsv: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    // pnpm/npm may forward the option separator into the script argv.
    if (arg === "--") {
      continue;
    }
    if (arg === "--all") {
      all = true;
      continue;
    }
    if (arg === "--changed-file") {
      changedFile = requireFlagValue("--changed-file", argv[++i]);
      continue;
    }
    if (arg === "--out-dir") {
      outDir = path.resolve(requireFlagValue("--out-dir", argv[++i]));
      continue;
    }
    if (arg === "--scenarios") {
      scenarioCsv = requireFlagValue("--scenarios", argv[++i]);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { all, changedFile, outDir, scenarioCsv };
}

async function readChangedPaths(changedFile: string | undefined) {
  if (!changedFile) return [];
  const text = await fs.readFile(changedFile, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function shotName(scenarioId: string, viewport: VisualViewport) {
  return `${scenarioId}__${viewport.name}.png`;
}

function isKeyboardDockedComposerPrepare(
  prepare: VisualScenarioPrepare | undefined,
): prepare is VisualScenarioPrepare {
  // Only reply threads pin the composer to the visual viewport bottom.
  // Create mode is a centered empty-state form and uses a full-page shot.
  return prepare === "conversation-detail-focused";
}

function attachmentImage(page: Page) {
  return page
    .locator('a[href*="/attachments/qa-chart-png"]')
    .filter({ has: page.locator('img[alt="chart.png"]') })
    .filter({ hasNot: page.locator("dialog") })
    .first();
}

/** Simulate an open software keyboard and wait for the shell to dock to it. */
async function dockFocusedComposerToKeyboard(
  page: Page,
  composer: ReturnType<Page["getByLabel"]>,
): Promise<void> {
  await composer.focus();
  // Mirror the physical iOS sequence: height-only resize first (offset still 0),
  // then the first dock as a visualViewport scroll. The screenshot clips to this
  // visual rectangle so its bottom edge is the keyboard edge.
  await page.evaluate(({ heightPx }) => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: heightPx },
      offsetTop: { configurable: true, value: 0 },
    });
    window.visualViewport?.dispatchEvent(new Event("resize"));
  }, { heightPx: FOCUSED_COMPOSER_VISUAL_HEIGHT_PX });
  const shell = page.locator("main").first();
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-height"),
      ),
    )
    .toBe(`${FOCUSED_COMPOSER_VISUAL_HEIGHT_PX}px`);
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-keyboard-open"),
      ),
    )
    .toBe("1");

  await page.evaluate(({ heightPx, offsetTopPx }) => {
    Object.defineProperties(window.visualViewport, {
      height: { configurable: true, value: heightPx },
      offsetTop: { configurable: true, value: offsetTopPx },
    });
    window.visualViewport?.dispatchEvent(new Event("scroll"));
  }, {
    heightPx: FOCUSED_COMPOSER_VISUAL_HEIGHT_PX,
    offsetTopPx: FOCUSED_COMPOSER_VISUAL_OFFSET_TOP_PX,
  });
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-viewport-offset-top"),
      ),
    )
    .toBe(`${FOCUSED_COMPOSER_VISUAL_OFFSET_TOP_PX}px`);
  await expect(composer).toBeFocused();
}

async function prepareScenario(
  page: Page,
  prepare: VisualScenarioPrepare | undefined,
  _viewport: VisualViewport,
): Promise<void> {
  if (!prepare) return;
  if (prepare === "attachment-entry" || prepare === "attachment-modal") {
    const image = attachmentImage(page);
    await image.waitFor({ state: "visible", timeout: 15_000 });
    await image.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    if (prepare === "attachment-modal") {
      await image.click();
      await page.locator("dialog[open]").waitFor({
        state: "visible",
        timeout: 5_000,
      });
    }
    return;
  }
  if (prepare === "new-conversation-focused") {
    await page.getByRole("button", { name: "New conversation" }).click();
    const composer = page.getByLabel("Start a conversation");
    await page
      .getByRole("heading", { name: "What do you need?", exact: true })
      .waitFor({ state: "visible", timeout: 15_000 });
    // Capture the greeting + hero composer empty state, not a keyboard dock.
    await composer.focus();
    await expect(composer).toBeFocused();
    return;
  }
  if (prepare === "conversation-detail-focused") {
    const composer = page.getByPlaceholder("Message Junior…");
    await expect(composer).toBeVisible();
    await dockFocusedComposerToKeyboard(page, composer);
    return;
  }
  const _exhaustive: never = prepare;
  throw new Error(`Unknown visual prepare: ${_exhaustive}`);
}

async function captureScenario(options: {
  baseURL: string;
  outDir: string;
  page: Page;
  scenario: VisualScenario;
}): Promise<CaptureShot[]> {
  const { baseURL, outDir, page, scenario } = options;
  const shots: CaptureShot[] = [];

  for (const viewport of scenario.viewports) {
    await page.setViewportSize({
      height: viewport.height,
      width: viewport.width,
    });
    const url = new URL(scenario.path, baseURL).toString();
    await page.goto(url, { waitUntil: "networkidle" });
    await page
      .getByRole("heading", { name: scenario.ready, exact: true })
      .first()
      .waitFor({ state: "visible", timeout: 15_000 });
    await prepareScenario(page, scenario.prepare, viewport);

    // Let layout/fonts settle before the shot.
    await page.evaluate(async () => {
      await document.fonts.ready;
    });

    const file = shotName(scenario.id, viewport);
    await page.screenshot({
      animations: "disabled",
      // Reply keyboard-dock shots clip to the visual viewport. Other shots,
      // including centered create compose, capture the full page.
      clip: isKeyboardDockedComposerPrepare(scenario.prepare)
        ? {
            height: FOCUSED_COMPOSER_VISUAL_HEIGHT_PX,
            width: viewport.width,
            x: 0,
            y: FOCUSED_COMPOSER_VISUAL_OFFSET_TOP_PX,
          }
        : undefined,
      fullPage: isKeyboardDockedComposerPrepare(scenario.prepare)
        ? false
        : true,
      path: path.join(outDir, file),
      type: "png",
    });

    shots.push({
      file,
      label: `${scenario.label} · ${viewport.name}`,
    });
  }

  return shots;
}

async function main() {
  const { all, changedFile, outDir, scenarioCsv } = parseArgs(
    process.argv.slice(2),
  );
  const changedPaths = await readChangedPaths(changedFile);
  const mode = all ? "all" : scenarioCsv ? "explicit" : "path";
  const scenarioIds = all
    ? selectVisualScenarioIds(changedPaths, { all: true })
    : scenarioCsv
      ? scenarioCsv
          .split(",")
          .map((value) => value.trim())
          .filter(Boolean)
      : selectVisualScenarioIds(changedPaths);

  const reasons = all
    ? [`forced full suite (--all or ${VISUAL_ALL_LABEL})`]
    : changedPaths.filter((filePath) =>
        filePath.replaceAll("\\", "/").startsWith("packages/junior-dashboard/"),
      );

  await fs.rm(outDir, { force: true, recursive: true });
  await fs.mkdir(outDir, { recursive: true });

  if (scenarioIds.length === 0) {
    const empty: CaptureManifest = {
      commitSha: process.env.GITHUB_SHA ?? null,
      mode,
      reasons,
      scenarioIds: [],
      shots: [],
      skipped: true,
    };
    await fs.writeFile(
      path.join(outDir, "manifest.json"),
      `${JSON.stringify(empty, null, 2)}\n`,
    );
    console.log("visual capture skipped: no matching dashboard scenarios");
    return;
  }

  const scenarios = resolveVisualScenarios(scenarioIds);
  const needsGallery = scenarios.some((scenario) => scenario.componentGallery);
  const server = await startDashboardE2eServer({
    componentGallery: needsGallery,
  });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await mockDashboardApis(page);

  const shots: CaptureShot[] = [];
  try {
    for (const scenario of scenarios) {
      shots.push(
        ...(await captureScenario({
          baseURL: server.baseURL,
          outDir,
          page,
          scenario,
        })),
      );
    }
  } finally {
    await browser.close();
    await server.close();
  }

  const manifest: CaptureManifest = {
    commitSha: process.env.GITHUB_SHA ?? null,
    mode,
    reasons: reasons.slice(0, 20),
    scenarioIds,
    shots,
    skipped: false,
  };
  await fs.writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  console.log(
    `visual capture wrote ${shots.length} shot(s) for ${scenarioIds.join(", ")}`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
