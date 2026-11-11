/**
 * The daily reconcile of open Junior pull requests.
 *
 * Only `pull_request` webhooks change a stored pull request. When GitHub
 * does not deliver a close, or its handler fails, the row stays open. Once a
 * day for each repository, the heartbeat compares the stored open rows with
 * GitHub's open search. It reads each pull request that the search does not
 * list, and records a close through the webhook write path, with its
 * merged or closed_unmerged event. The write is guarded by `updatedAt`, so a
 * replay cannot move a newer row back.
 */
import type {
  CodeChangePublisher,
  EventPublisher,
  PluginConversationAnnotations,
  PluginLogger,
  PluginState,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import {
  listOpenGitHubPullRequests,
  type SearchOpenPullRequests,
} from "../open-pull-requests.js";
import { gitHubPullRequestTerminalEvents } from "../webhooks/events.js";
import { normalizeGitHubPullRequestOutcome } from "../webhooks/pull-request-outcome.js";
import { applyGitHubPullRequestOutcome } from "./apply.js";
import { listGitHubStaleOpenPullRequests } from "./store.js";

/**
 * Time between the reconciles of one repository. A row with a newer
 * lifecycle change waits, because its webhook can still arrive.
 */
const RECONCILE_MS = 24 * 60 * 60_000;

/** Repositories per heartbeat. */
const REPOSITORY_LIMIT = 1;

/** Pull request reads per repository reconcile. The rest wait a day. */
const READ_LIMIT = 10;

const pullRequestSchema = z
  .object({
    base: z.object({
      repo: z.object({
        full_name: z.string().min(1),
        id: z.number().int().positive(),
      }),
    }),
    state: z.enum(["open", "closed"]),
  })
  .passthrough();

interface ReconcileArgs {
  annotations: PluginConversationAnnotations;
  botEmail?: string;
  codeChanges: CodeChangePublisher;
  db: GitHubDb;
  events: EventPublisher;
  /** Read one pull request from the GitHub REST API. */
  loadPullRequest(pullRequest: {
    number: number;
    repositoryFullName: string;
  }): Promise<unknown>;
  log: Pick<PluginLogger, "error" | "warn">;
  nowMs: number;
  search: SearchOpenPullRequests;
  state: PluginState;
}

async function reconcileRepository(
  args: ReconcileArgs,
  repositoryFullName: string,
  numbers: number[],
): Promise<void> {
  const { complete, pullRequests } = await listOpenGitHubPullRequests(
    args.search,
    repositoryFullName,
  );
  if (!complete) {
    // A pull request past the search limit is open, but not in the list.
    // The reads would find the same open pull requests every day.
    args.log.warn("GitHub pull request reconcile skipped a partial search", {
      repository: repositoryFullName,
    });
    return;
  }
  const open = new Set(pullRequests.map((pullRequest) => pullRequest.number));
  const missing = numbers.filter((number) => !open.has(number));
  for (const number of missing.slice(0, READ_LIMIT)) {
    const pullRequest = pullRequestSchema.parse(
      await args.loadPullRequest({ number, repositoryFullName }),
    );
    // The search index can lag behind GitHub.
    if (pullRequest.state === "open") continue;
    const body = {
      action: "closed",
      pull_request: pullRequest,
      repository: pullRequest.base.repo,
    };
    const outcome = normalizeGitHubPullRequestOutcome({
      body,
      botEmail: args.botEmail,
    });
    if (!outcome) continue;
    const recorded = await applyGitHubPullRequestOutcome({
      annotations: args.annotations,
      codeChanges: args.codeChanges,
      db: args.db,
      log: args.log,
      outcome,
    });
    if (!recorded.applied) continue;
    // These have the key of the webhook events for this close, so a Watch
    // gets the close once, even when the webhook arrives later.
    for (const event of gitHubPullRequestTerminalEvents(body)) {
      await args.events.publish({ ...event, objectType: "code_change" });
    }
  }
}

/**
 * Reconcile the next repository that has open Junior pull requests and was
 * not reconciled in the last day.
 */
export async function reconcileGitHubPullRequests(
  args: ReconcileArgs,
): Promise<void> {
  const numbersByRepository = new Map<string, number[]>();
  for (const row of await listGitHubStaleOpenPullRequests(
    args.db,
    new Date(args.nowMs - RECONCILE_MS),
  )) {
    const numbers = numbersByRepository.get(row.repositoryFullName) ?? [];
    numbers.push(row.number);
    numbersByRepository.set(row.repositoryFullName, numbers);
  }
  let reconciled = 0;
  for (const [repositoryFullName, numbers] of numbersByRepository) {
    if (reconciled >= REPOSITORY_LIMIT) break;
    // Claim before the GitHub reads. A failed reconcile, such as one that
    // GitHub rate limits, runs again when the claim ends.
    const claimed = await args.state.setIfNotExists(
      `pull-request-reconcile:${repositoryFullName}`,
      args.nowMs,
      RECONCILE_MS,
    );
    if (!claimed) continue;
    reconciled += 1;
    try {
      await reconcileRepository(args, repositoryFullName, numbers);
    } catch (error) {
      args.log.error("GitHub pull request reconcile failed", {
        errorType: error instanceof Error ? error.name : "UnknownError",
        repository: repositoryFullName,
      });
    }
  }
}
