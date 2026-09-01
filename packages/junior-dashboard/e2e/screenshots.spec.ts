import path from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./test";

const DESKTOP = { height: 900, name: "desktop", width: 1440 } as const;
const MOBILE = { height: 844, name: "mobile", width: 390 } as const;
const FOCUSED_COMPOSER_HEIGHT_PX = 520;
const FOCUSED_COMPOSER_OFFSET_TOP_PX = 140;
const SCREENSHOT_DIR = path.resolve(".playwright/junior-dashboard/screenshots");

type ScreenshotPrepare =
  | "attachment-entry"
  | "attachment-modal"
  | "conversation-detail-focused"
  | "new-conversation-focused";

type ScreenshotScenario = {
  id: string;
  path: string;
  prepare?: ScreenshotPrepare;
  ready: string;
  viewports: readonly (typeof DESKTOP | typeof MOBILE)[];
};

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const DASHBOARD_QA_CONVERSATION_ID = "internal:dashboard-qa";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

const SCREENSHOT_SCENARIOS: ScreenshotScenario[] = [
  {
    id: "conversations",
    path: "/",
    ready: "What do you need?",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "conversation-detail",
    path: `/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
    ready: "Investigate checkout latency",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "conversation-attachment",
    path: `/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`,
    prepare: "attachment-entry",
    ready: "Dashboard QA edge cases",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "conversation-attachment-modal",
    path: `/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`,
    prepare: "attachment-modal",
    ready: "Dashboard QA edge cases",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "conversation-detail-focused",
    path: `/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
    prepare: "conversation-detail-focused",
    ready: "Investigate checkout latency",
    viewports: [MOBILE],
  },
  {
    id: "conversation-create-focused",
    path: "/",
    prepare: "new-conversation-focused",
    ready: "What do you need?",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "person-profile",
    path: `/people/${encodeURIComponent("avery@sentry.io")}`,
    ready: "Code",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "code",
    path: "/code",
    ready: "Code",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "system",
    path: "/system",
    ready: "System",
    viewports: [DESKTOP],
  },
  {
    id: "workspaces",
    path: "/system/workspaces",
    ready: "Baseline snapshot",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "workspace-detail",
    path: `/system/workspaces/${WORKSPACE_ID}`,
    ready: "Current snapshot",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "tasks-list",
    path: "/tasks/list",
    ready: "All tasks",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "memories",
    path: "/memories",
    ready: "Memories",
    viewports: [DESKTOP],
  },
  {
    id: "settings",
    path: "/settings",
    ready: "Settings",
    viewports: [DESKTOP],
  },
  {
    id: "gallery-index",
    path: "/dev",
    ready: "Component gallery",
    viewports: [DESKTOP],
  },
  {
    id: "gallery-foundations",
    path: "/dev/foundations",
    ready: "Foundations",
    viewports: [DESKTOP],
  },
  {
    id: "gallery-charts",
    path: "/dev/charts",
    ready: "Charts",
    viewports: [DESKTOP],
  },
  {
    id: "gallery-transcripts",
    path: "/dev/transcripts",
    ready: "Transcripts",
    viewports: [DESKTOP],
  },
];

function attachmentImage(page: Page) {
  return page
    .locator('a[href*="/attachments/qa-chart-png"]')
    .filter({ has: page.locator('img[alt="chart.png"]') })
    .filter({ hasNot: page.locator("dialog") })
    .first();
}

async function prepareScreenshot(page: Page, prepare?: ScreenshotPrepare) {
  if (!prepare) return;

  if (prepare === "attachment-entry" || prepare === "attachment-modal") {
    const image = attachmentImage(page);
    await image.waitFor({ state: "visible" });
    await image.evaluate((element) =>
      element.scrollIntoView({ block: "center", inline: "nearest" }),
    );
    if (prepare === "attachment-modal") {
      await image.click();
      await expect(page.locator("dialog[open]")).toBeVisible();
    }
    return;
  }

  if (prepare === "new-conversation-focused") {
    const composer = page.getByLabel("Start a conversation");
    await composer.focus();
    await expect(composer).toBeFocused();
    return;
  }

  const composer = page.getByPlaceholder("Message Junior…");
  await composer.focus();
  await page.evaluate(
    ({ height, offsetTop }) => {
      Object.defineProperties(window.visualViewport, {
        height: { configurable: true, value: height },
        offsetTop: { configurable: true, value: offsetTop },
      });
      window.visualViewport?.dispatchEvent(new Event("resize"));
    },
    {
      height: FOCUSED_COMPOSER_HEIGHT_PX,
      offsetTop: FOCUSED_COMPOSER_OFFSET_TOP_PX,
    },
  );
  const shell = page.locator("main").first();
  await expect
    .poll(() =>
      shell.evaluate((element) =>
        element.style.getPropertyValue("--dashboard-keyboard-open"),
      ),
    )
    .toBe("1");
  await expect(composer).toBeFocused();
}

for (const scenario of SCREENSHOT_SCENARIOS) {
  for (const viewport of scenario.viewports) {
    test(`captures ${scenario.id} on ${viewport.name}`, async ({
      page,
      dashboard,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto(new URL(scenario.path, dashboard.baseURL).toString(), {
        waitUntil: "networkidle",
      });
      await page
        .getByRole("heading", { name: scenario.ready, exact: true })
        .first()
        .waitFor({ state: "visible" });
      await prepareScreenshot(page, scenario.prepare);
      await page.evaluate(() => document.fonts.ready);

      const focusedComposer =
        scenario.prepare === "conversation-detail-focused";
      await page.screenshot({
        animations: "disabled",
        clip: focusedComposer
          ? {
              height: FOCUSED_COMPOSER_HEIGHT_PX,
              width: viewport.width,
              x: 0,
              y: FOCUSED_COMPOSER_OFFSET_TOP_PX,
            }
          : undefined,
        fullPage: !focusedComposer,
        path: path.join(SCREENSHOT_DIR, `${scenario.id}__${viewport.name}.png`),
      });
    });
  }
}
