import type { Page } from "@playwright/test";
import type {
  AutomationExecution,
  AutomationSummary,
} from "@sentry/junior/api/schema";
import { mockAutomationCollection } from "../src/mock-reporting/automation-collection";
import { NOW_MS } from "../src/mock-reporting/fixtures";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

type RunPlan = {
  /** One letter per run, oldest first: c completed, f failed, b blocked. */
  results: string;
  /** Hours between runs. */
  every: number;
  /** Hours since the newest run. */
  lastAgo: number;
  durationMs: number;
  costUsd: number;
  error?: string;
};

const STATUS = { b: "blocked", c: "completed", f: "failed" } as const;

function executions(id: string, title: string, plan: RunPlan) {
  const count = plan.results.length;
  return Array.from(plan.results).map((letter, index): AutomationExecution => {
    const status = STATUS[letter as keyof typeof STATUS];
    const executedAt = new Date(
      NOW_MS - (plan.lastAgo + (count - 1 - index) * plan.every) * HOUR,
    ).toISOString();
    // Vary durations so the strip shows a shape, not a flat bar.
    const durationMs = Math.round(
      plan.durationMs * (0.7 + ((index * 37) % 50) / 100),
    );
    const run: AutomationExecution = {
      automationVersion: status === "completed" ? 6 : 7,
      executedAt,
      executionId: `${id}-run-${index}`,
      status,
      title,
    };
    // Blocked runs never start a Conversation, so they have no usage.
    if (status !== "blocked") {
      run.conversationId = `automation:${id}:${index}`;
      run.costUsd =
        Math.round(plan.costUsd * 100 * (0.8 + (index % 5) / 10)) / 100;
      run.durationMs = status === "failed" ? plan.durationMs * 3 : durationMs;
      run.totalTokens = 1_200 + index * 140;
    }
    if (status !== "completed" && plan.error) run.error = plan.error;
    return run;
  });
}

function automation(
  base: Omit<
    AutomationSummary,
    | "costUsd"
    | "createdAt"
    | "credentialMode"
    | "destination"
    | "runs"
    | "outcomes"
    | "totalRuns"
    | "recentRuns"
    | "lastRunAt"
    | "lastRunStatus"
  > & {
    channel: string;
    private?: boolean;
  },
  plan: RunPlan,
): { summary: AutomationSummary; runs: AutomationExecution[] } {
  const { channel, private: isPrivate, ...rest } = base;
  // Long-lived Automations have more history than the list strip shows.
  const history =
    plan.results.length >= 20
      ? { ...plan, results: `${"c".repeat(28)}${plan.results}` }
      : plan;
  const runs = executions(base.id, base.title, history);
  const summary = {
    ...rest,
    costUsd: {
      1: plan.costUsd,
      7: plan.costUsd * 5,
      30: plan.costUsd * 20,
      90: plan.costUsd * 60,
    },
    createdAt: new Date(NOW_MS - 60 * DAY).toISOString(),
    credentialMode: "creator",
    destination: {
      channelId: `C-${base.id}`,
      label: channel,
      teamId: "T123",
      visibility: isPrivate ? "private" : "public",
    },
    outcomes: [],
    recentRuns: runs.slice(-20).map((run) => {
      const recent: AutomationSummary["recentRuns"][number] = {
        executedAt: run.executedAt,
        status: run.status,
      };
      if (run.durationMs !== undefined) recent.durationMs = run.durationMs;
      return recent;
    }),
    runs: { 1: 1, 7: 5, 30: 20, 90: 60 },
    totalCostUsd: plan.costUsd * 60,
    totalRuns: 60,
  } as AutomationSummary;
  const last = runs.at(-1);
  if (last) {
    summary.lastRunAt = last.executedAt;
    summary.lastRunStatus = last.status;
    if (last.conversationId) summary.lastConversationId = last.conversationId;
  }
  return { summary, runs };
}

const iso = (hoursFromNow: number) =>
  new Date(NOW_MS + hoursFromNow * HOUR).toISOString();

/** A realistic mix of healthy, failing, blocked, paused, and finished work. */
export const landingAutomations = [
  automation(
    {
      channel: "#security-alerts",
      createdBy: "Dashboard User",
      id: "cve-sweep",
      task: {
        kind: "skill",
        skill: "cve-now",
        context: "Report only findings that survive the skeptic.",
      },
      kind: "scheduled",
      nextRunAt: iso(19),
      ownedByViewer: true,
      schedule: "Every day at 7:00 AM",
      status: "active",
      timezone: "UTC",
      title: "CVE sweep",
    },
    {
      costUsd: 1.9,
      durationMs: 6 * 60_000,
      every: 24,
      error:
        "Timed out after 15m while 9 of 23 analyst agents were still working.",
      lastAgo: 5,
      results: "cccccccccccccccccfff",
    },
  ),
  automation(
    {
      channel: "#proj-junior",
      createdBy: "Dashboard User",
      id: "release-train",
      task: {
        kind: "instruction",
        instruction:
          "Check getsentry/junior for changes since the last release. When there are any, cut and publish a release, then post the outcome.",
      },
      kind: "scheduled",
      nextRunAt: iso(22),
      ownedByViewer: true,
      schedule: "Weekdays at 10:00 AM",
      status: "blocked",
      statusReason:
        "Your GitHub connection expired. Reconnect GitHub, then resume.",
      timezone: "America/Los_Angeles",
      title: "Release train: junior",
    },
    {
      costUsd: 0.6,
      durationMs: 4 * 60_000,
      every: 24,
      error: "GitHub credentials expired.",
      lastAgo: 26,
      results: "ccccccccccccccccbbb",
    },
  ),
  automation(
    {
      channel: "#fair-source",
      createdBy: "Avery Chen",
      id: "fair-source-review",
      task: {
        kind: "instruction",
        instruction:
          "Review the fair.io pull request. Check the listing entry, the logo, the license, and the announcement post.",
      },
      kind: "event",
      ownedByViewer: false,
      resource: "Repository · fairsource/fair.io",
      source: "github",
      status: "active",
      title: "Fair Source PR review",
      trigger: {
        events: ["pull request opened"],
        filters: [],
        problems: ["The GitHub App is not installed on fairsource/fair.io."],
      },
    },
    {
      costUsd: 0.3,
      durationMs: 3 * 60_000,
      every: 30,
      lastAgo: 9 * 24,
      results: "cccccccc",
    },
  ),
  automation(
    {
      channel: "#streaming-oncall",
      createdBy: "Morgan Lee",
      id: "streaming-oncall",
      task: {
        kind: "instruction",
        instruction:
          "Run the streaming on-call check. Flag anything new on the Kafka, taskbroker, and spans dashboards since yesterday. Keep it under 10 bullets.",
      },
      kind: "scheduled",
      nextRunAt: iso(4),
      ownedByViewer: false,
      schedule: "Weekdays at 9:00 AM",
      status: "active",
      timezone: "America/Los_Angeles",
      title: "Streaming on-call check",
    },
    {
      costUsd: 0.42,
      durationMs: 150_000,
      every: 24,
      error: "Datadog returned 429 Too Many Requests.",
      lastAgo: 20,
      results: "cccccccccccfcccccccc",
    },
  ),
  automation(
    {
      channel: "#tpm-bugs",
      createdBy: "Dashboard User",
      id: "linear-urgent",
      task: {
        kind: "instruction",
        instruction:
          "Suggest a RICE priority for the new bug and say who should own it.",
      },
      kind: "event",
      ownedByViewer: true,
      resource: "Team · ENG",
      source: "linear",
      status: "active",
      title: "Triage new urgent Linear bugs",
      trigger: {
        events: ["issue created"],
        filters: ["priority is Urgent"],
        problems: [],
      },
    },
    {
      costUsd: 0.18,
      durationMs: 50_000,
      every: 7,
      error: "The Linear connection needs consent.",
      lastAgo: 2,
      results: "ccccccbccccccccccccc",
    },
  ),
  automation(
    {
      channel: "#proj-junior",
      createdBy: "Dashboard User",
      id: "post-merge-cleanup",
      task: {
        kind: "instruction",
        // Long, like real cleanup instructions, so the page shows the clamp.
        instruction: [
          "Once a day, review the commits that landed on the default branch of getsentry/junior during the previous calendar day. Look at the changes as a whole, not commit by commit, and decide whether they make anything deletable or in need of cleanup: skill instructions the runtime now handles, dead code, config that no longer does anything, and stale docs.",
          "Do not look for work just to look for work. Only act on cleanup that the previous day's changes directly caused and that you have checked against the current source. Do not do speculative refactors, style changes, or cleanup unrelated to those commits.",
          "Before you make any change, check whether a PR already covers it. Search open PRs and PRs merged since the causing commits landed, by the file paths, symbols, and causing PR numbers involved. Skip any cleanup that an existing PR already makes.",
          "If nothing needs to change, post one line that says so. Otherwise open one PR per cleanup and post the links.",
        ].join("\n\n"),
      },
      kind: "scheduled",
      nextRunAt: iso(9),
      ownedByViewer: true,
      schedule: "Every day at 6:00 PM",
      status: "active",
      timezone: "America/Los_Angeles",
      title: "Post-merge cleanup: getsentry/junior",
    },
    {
      costUsd: 1.2,
      durationMs: 9 * 60_000,
      every: 24,
      lastAgo: 15,
      results: "cccccccccccccccccccc",
    },
  ),
  automation(
    {
      channel: "Direct message",
      createdBy: "Dashboard User",
      id: "incident-summaries",
      task: {
        kind: "instruction",
        instruction:
          "When an incident channel opens, read it and post a three-line summary of what broke and who is on it.",
      },
      kind: "event",
      ownedByViewer: true,
      private: true,
      resource: "Workspace · Sentry",
      source: "slack",
      status: "active",
      title: "Summarize new incident channels",
      trigger: {
        events: ["channel created"],
        filters: ["name starts with inc-"],
        problems: [],
      },
    },
    {
      costUsd: 0.31,
      durationMs: 70_000,
      every: 40,
      lastAgo: 70,
      results: "cccccc",
    },
  ),
  automation(
    {
      channel: "#eng-managers",
      createdBy: "Morgan Lee",
      id: "bug-scorecard",
      task: {
        kind: "instruction",
        instruction: "Post the weekly bug scorecard for each team.",
      },
      kind: "scheduled",
      ownedByViewer: false,
      schedule: "Every Monday at 8:00 AM",
      status: "paused",
      timezone: "America/Los_Angeles",
      title: "Weekly bug scorecard",
    },
    {
      costUsd: 0.8,
      durationMs: 4 * 60_000,
      every: 7 * 24,
      lastAgo: 10 * 24,
      results: "cccccccc",
    },
  ),
];

/** Serve the landing list, details, runs, and versions from one fixture. */
export async function mockLandingAutomationApis(page: Page) {
  const report = {
    automations: landingAutomations.map((entry) => entry.summary),
  };
  await page.route(/\/api\/automations(?:\?.*)?$/, (route) =>
    route.fulfill({
      json: mockAutomationCollection(
        report,
        new URL(route.request().url()).searchParams,
      ),
    }),
  );
  const find = (id: string) =>
    landingAutomations.find((entry) => entry.summary.id === id);
  await page.route(/\/api\/automations\/[^/?]+$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-1)!;
    if (id === "runs") return route.fallback();
    const entry = find(decodeURIComponent(id));
    return route.fulfill({
      status: entry ? 200 : 404,
      json: entry?.summary ?? { error: "Automation not found." },
    });
  });
  await page.route(/\/api\/automations\/[^/?]+\/executions$/, (route) => {
    const id = new URL(route.request().url()).pathname.split("/").at(-2)!;
    const entry = find(decodeURIComponent(id));
    if (!entry) return route.fulfill({ status: 404, json: {} });
    const days = Array.from({ length: 90 }, (_, index) => {
      const date = new Date(NOW_MS - (89 - index) * DAY)
        .toISOString()
        .slice(0, 10);
      const day = entry.runs.filter((run) => run.executedAt.startsWith(date));
      return {
        blocked: day.filter((run) => run.status === "blocked").length,
        completed: day.filter((run) => run.status === "completed").length,
        costUsd:
          Math.round(
            day.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) * 100,
          ) / 100,
        date,
        failed: day.filter((run) => run.status === "failed").length,
      };
    });
    return route.fulfill({
      json: {
        automation: entry.summary,
        executionDays: days,
        executions: [...entry.runs].reverse(),
        truncated: false,
      },
    });
  });
  await page.route(/\/api\/automations\/[^/?]+\/versions$/, (route) =>
    route.fulfill({
      json: { activeVersion: 7, truncated: false, versions: [] },
    }),
  );
}
