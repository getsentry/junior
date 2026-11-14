import type { Page } from "@playwright/test";
import type { AutomationList } from "@sentry/junior/api/schema";
import { mockAutomationCollection } from "../src/mock-reporting/automation-collection";

export const automationReport: Pick<AutomationList, "automations"> = {
  automations: [
    {
      createdAt: "2026-07-28T16:00:00.000Z",
      createdBy: "Morgan",
      createdByEmail: "dev@example.com",
      destination: {
        channelId: "C123",
        label: "#project-updates",
        teamId: "T123",
        visibility: "public",
      },
      id: "scheduled-1",
      task: {
        kind: "instruction",
        instruction: "Send the weekly project summary",
      },
      kind: "scheduled",
      lastConversationId: "scheduler:daily-ops-digest",
      lastRunAt: "2026-08-06T16:00:00.000Z",
      lastRunStatus: "completed",
      nextRunAt: "2026-08-10T16:00:00.000Z",
      credentialMode: "creator",
      ownedByViewer: true,
      costUsd: { 1: 0.42, 7: 1.02, 30: 4.18, 90: 16.4 },
      runs: { 1: 1, 7: 3, 30: 12, 90: 48 },
      schedule: "Every Monday at 9:00 AM",
      timezone: "America/Los_Angeles",
      status: "active",
      outcomes: [
        {
          action: "send_message",
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId: "C123",
          },
        },
      ],
      title: "Weekly project summary",
      recentRuns: [
        {
          durationMs: 42_000,
          executedAt: "2026-08-04T16:00:00.000Z",
          status: "blocked",
        },
        {
          durationMs: 18_000,
          executedAt: "2026-08-05T16:00:00.000Z",
          status: "failed",
        },
        {
          durationMs: 42_000,
          executedAt: "2026-08-06T16:00:00.000Z",
          status: "completed",
        },
      ],
      totalCostUsd: 18.62,
      totalRuns: 48,
    },
    {
      createdAt: "2026-07-29T16:00:00.000Z",
      createdBy: "Morgan",
      createdByEmail: "dev@example.com",
      destination: {
        channelId: "C123",
        label: "#project-updates",
        teamId: "T123",
        visibility: "public",
      },
      id: "event-1",
      task: { kind: "instruction", instruction: "Summarize the closed issue" },
      kind: "event",
      lastConversationId: "agent-dispatch:event-1",
      lastRunAt: "2026-08-05T18:30:00.000Z",
      lastRunStatus: "completed",
      credentialMode: "creator",
      ownedByViewer: true,
      resource: "Issue · ACME-42",
      costUsd: { 1: 0, 7: 0.12, 30: 0.48, 90: 0.84 },
      runs: { 1: 0, 7: 1, 30: 4, 90: 7 },
      source: "github",
      outcomes: [],
      title: "Closed issue summary",
      recentRuns: [],
      totalCostUsd: 0.84,
      totalRuns: 7,
      trigger: {
        events: ["issue closed"],
        filters: ["labels includes bug"],
        problems: [],
      },
      status: "active",
    },
    {
      createdAt: "2026-07-30T16:00:00.000Z",
      createdBy: "Avery Chen",
      createdByEmail: "avery@sentry.io",
      destination: {
        channelId: "C456",
        label: "#incident-response",
        teamId: "T123",
        visibility: "public",
      },
      id: "event-2",
      task: {
        kind: "instruction",
        instruction: "Notify responders when the incident changes",
      },
      kind: "event",
      credentialMode: "creator",
      ownedByViewer: false,
      resource: "Incident · INC-17",
      costUsd: { 1: 0, 7: 0, 30: 0, 90: 0 },
      runs: { 1: 0, 7: 0, 30: 0, 90: 0 },
      source: "pagerduty",
      outcomes: [
        {
          action: "send_message",
          destination: {
            platform: "slack",
            teamId: "T123",
            channelId: "C123",
          },
        },
      ],
      title: "Incident change alerts",
      recentRuns: [],
      totalCostUsd: 0,
      totalRuns: 0,
      trigger: {
        events: ["incident updated"],
        filters: [],
        problems: ["The plugin for this source is not enabled."],
      },
      status: "active",
    },
  ],
};

/**
 * Count the viewer's Automations that need attention, as the Inbox count
 * endpoint does, so the tab badge matches the mocked list.
 */
export function attentionCount(
  report: Pick<AutomationList, "automations"> = automationReport,
): number {
  return mockAutomationCollection(
    report,
    new URLSearchParams({ owner: "me", scope: "attention" }),
  ).total;
}

/** Serve the Automation collection and direct details from the same fixture. */
export async function mockAutomationApis(page: Page) {
  await page.route("**/api/review-items/count", async (route) => {
    // A navigation can cancel the count read before the fetch here ends.
    const response = await route.fetch().catch(() => undefined);
    if (!response) return route.abort().catch(() => {});
    await route.fulfill({
      response,
      json: { ...(await response.json()), automations: attentionCount() },
    });
  });
  await page.route(/\/api\/automations(?:\?.*)?$/, async (route) => {
    await route.fulfill({
      json: mockAutomationCollection(
        automationReport,
        new URL(route.request().url()).searchParams,
      ),
    });
  });
  await page.route(/\/api\/automations\/[^/?]+$/, async (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-1)!,
    );
    const automation = automationReport.automations.find(
      (automation) => automation.id === id,
    );
    if (id === "runs") return route.fallback();
    await route.fulfill({
      status: automation ? 200 : 404,
      json: automation ?? { error: "Automation not found." },
    });
  });
  await page.route(/\/api\/automations\/[^/?]+\/versions$/, (route) =>
    route.fulfill({
      json: { versions: [], activeVersion: null, truncated: false },
    }),
  );
}
