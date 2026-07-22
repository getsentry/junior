import type { PluginOperationalReportContent } from "@sentry/junior-plugin-api";
import { eq, gte, or } from "drizzle-orm";
import { juniorGitHubPullRequests } from "../db/schema.js";
import {
  parseGitHubPullRequestRows,
  type GitHubDb,
  type GitHubPullRequestRow,
} from "./store.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const WINDOWS = [7, 30, 90] as const;

interface OutcomeStats {
  closed: number;
  created: number;
  medianMergeTimeMs?: number;
  mergeRate?: number;
  merged: number;
  open: number;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle];
}

function outcomeStats(
  rows: GitHubPullRequestRow[],
  nowMs: number,
  days: number,
): OutcomeStats {
  const startMs = nowMs - days * DAY_MS;
  const created = rows.filter((row) => row.openedAt.getTime() >= startMs);
  const merged = rows.filter(
    (row) =>
      row.state === "merged" && (row.mergedAt?.getTime() ?? 0) >= startMs,
  );
  const closed = rows.filter(
    (row) =>
      row.state === "closed_unmerged" &&
      (row.closedAt?.getTime() ?? 0) >= startMs,
  );
  const terminal = merged.length + closed.length;
  return {
    closed: closed.length,
    created: created.length,
    medianMergeTimeMs: median(
      merged.map((row) => row.mergedAt!.getTime() - row.openedAt.getTime()),
    ),
    mergeRate: terminal > 0 ? merged.length / terminal : undefined,
    merged: merged.length,
    open: rows.filter((row) => row.state === "open").length,
  };
}

function formatPercent(value: number | undefined): string {
  return value === undefined ? "—" : `${Math.round(value * 100)}%`;
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) return "—";
  const hours = value / (60 * 60 * 1_000);
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  if (hours < 24) return `${Math.round(hours * 10) / 10}h`;
  return `${Math.round((hours / 24) * 10) / 10}d`;
}

function repositoryRows(rows: GitHubPullRequestRow[], nowMs: number) {
  const byRepository = new Map<string, GitHubPullRequestRow[]>();
  for (const row of rows) {
    const current = byRepository.get(row.repositoryFullName) ?? [];
    current.push(row);
    byRepository.set(row.repositoryFullName, current);
  }
  return [...byRepository.entries()]
    .map(([repository, repositoryOutcomes]) => ({
      repository,
      stats: outcomeStats(repositoryOutcomes, nowMs, 30),
    }))
    .filter(
      ({ stats }) =>
        stats.created + stats.merged + stats.closed + stats.open > 0,
    )
    .sort(
      (left, right) =>
        right.stats.merged - left.stats.merged ||
        right.stats.created - left.stats.created ||
        left.repository.localeCompare(right.repository),
    )
    .slice(0, 25);
}

/** Build the generic dashboard report for Junior-owned pull request outcomes. */
export async function buildGitHubOutcomeReport(args: {
  db: GitHubDb;
  nowMs: number;
}): Promise<PluginOperationalReportContent> {
  const start = new Date(args.nowMs - 90 * DAY_MS);
  const rows = parseGitHubPullRequestRows(
    await args.db
      .select()
      .from(juniorGitHubPullRequests)
      .where(
        or(
          eq(juniorGitHubPullRequests.state, "open"),
          gte(juniorGitHubPullRequests.openedAt, start),
          gte(juniorGitHubPullRequests.mergedAt, start),
          gte(juniorGitHubPullRequests.closedAt, start),
        ),
      ),
  );
  const windows = WINDOWS.map((days) => ({
    days,
    stats: outcomeStats(rows, args.nowMs, days),
  }));
  const thirtyDays = windows.find((window) => window.days === 30)!.stats;

  return {
    generatedAt: new Date(args.nowMs).toISOString(),
    title: "GitHub work delivered",
    metrics: [
      { label: "created · 30d", value: String(thirtyDays.created) },
      {
        label: "merged · 30d",
        tone: thirtyDays.merged > 0 ? "good" : "neutral",
        value: String(thirtyDays.merged),
      },
      { label: "closed unmerged · 30d", value: String(thirtyDays.closed) },
      { label: "open now", value: String(thirtyDays.open) },
      { label: "merge rate · 30d", value: formatPercent(thirtyDays.mergeRate) },
      {
        label: "median merge time · 30d",
        value: formatDuration(thirtyDays.medianMergeTimeMs),
      },
    ],
    recordSets: [
      {
        title: "Outcome windows",
        fields: [
          { key: "window", label: "Window" },
          { key: "created", label: "Created" },
          { key: "merged", label: "Merged" },
          { key: "closed", label: "Closed unmerged" },
          { key: "mergeRate", label: "Merge rate" },
          { key: "mergeTime", label: "Median merge time" },
        ],
        records: windows.map(({ days, stats }) => ({
          id: `${days}d`,
          values: {
            window: `${days} days`,
            created: String(stats.created),
            merged: String(stats.merged),
            closed: String(stats.closed),
            mergeRate: formatPercent(stats.mergeRate),
            mergeTime: formatDuration(stats.medianMergeTimeMs),
          },
        })),
      },
      {
        title: "Repositories · 30d",
        emptyText: "No Junior-owned pull request activity yet.",
        fields: [
          { key: "repository", label: "Repository" },
          { key: "created", label: "Created" },
          { key: "merged", label: "Merged" },
          { key: "closed", label: "Closed unmerged" },
          { key: "open", label: "Open now" },
          { key: "mergeRate", label: "Merge rate" },
        ],
        records: repositoryRows(rows, args.nowMs).map(
          ({ repository, stats }) => ({
            id: repository,
            values: {
              repository,
              created: String(stats.created),
              merged: String(stats.merged),
              closed: String(stats.closed),
              open: String(stats.open),
              mergeRate: formatPercent(stats.mergeRate),
            },
          }),
        ),
      },
    ],
  };
}
