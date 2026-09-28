import type { Page } from "@playwright/test";
import {
  automationEditSchema,
  type AutomationEdit,
} from "@sentry/junior/api/schema";
import { automationReport } from "./automation-fixture";

/** Supply exact edit values while the shared fixture owns list and public reads. */
export async function mockAutomationEditor(
  page: Page,
  kind: "scheduled" | "event",
) {
  const summary = automationReport.automations.find(
    (value) => value.id === `${kind}-1`,
  )!;
  const common = {
    id: summary.id,
    revision: "a".repeat(64),
    title: summary.title,
    instruction: summary.instruction,
    credentialMode: "creator",
    outcomes: summary.outcomes,
    destination: {
      platform: "slack",
      channelId: summary.destination.channelId,
      teamId: summary.destination.teamId,
    },
    createdBy: { slackUserId: "U123" },
  };
  const value = automationEditSchema.parse(
    kind === "scheduled"
      ? {
          ...common,
          kind,
          status: "active",
          nextRunAtMs: Date.parse("2026-08-10T16:00:00Z"),
          schedule: {
            kind: "recurring",
            description: "Every Monday at 9 AM",
            timezone: "America/Los_Angeles",
            recurrence: {
              frequency: "weekly",
              interval: 1,
              startDate: "2026-08-03",
              time: { hour: 9, minute: 0 },
              weekdays: [1],
            },
          },
        }
      : {
          ...common,
          kind,
          triggerAvailable: true,
          trigger: {
            namespace: "github",
            resourceType: "issue",
            identifier: "getsentry/junior#42",
            label: "Issue 42",
            events: ["issue.closed"],
            match: {},
          },
        },
  );
  const state: { value: AutomationEdit; writes: unknown[] } = {
    value,
    writes: [],
  };
  const url = `**/api/automations/${kind}/${summary.id}`;
  await page.route(`${url}/edit`, (route) =>
    route.fulfill({ json: state.value }),
  );
  await page.route(`${url}/preview`, (route) =>
    route.fulfill({
      json: {
        nextRunAtMs: Date.parse("2026-08-11T16:00:00Z"),
        schedule:
          kind === "scheduled" && value.kind === "scheduled"
            ? value.schedule
            : {},
      },
    }),
  );
  await page.route("**/api/automations/event-catalog", (route) =>
    route.fulfill({
      json: [
        {
          namespace: "github",
          type: "issue",
          supportedEvents: ["issue.closed", "issue.opened"],
          matchFields: {
            state: {
              kind: "string",
              description: "Issue state",
              enum: ["open", "closed"],
            },
          },
        },
      ],
    }),
  );
  await page.route(url, async (route) => {
    if (route.request().method() !== "PATCH") return route.fallback();
    const body = route.request().postDataJSON();
    state.writes.push(body);
    state.value = { ...state.value, ...body, revision: "b".repeat(64) };
    await route.fulfill({ json: state.value });
  });
  return state;
}
