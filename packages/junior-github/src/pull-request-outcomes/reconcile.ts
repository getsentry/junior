/**
 * The daily reconcile of open Junior pull requests.
 *
 * Only `pull_request` webhooks change a stored pull request. When GitHub
 * does not deliver a close, or its handler fails, the row stays open. Once a
 * day for each repository, the heartbeat reads the stored open rows from
 * GitHub with GraphQL. Each close goes through the webhook write path, with
 * its merged or closed_unmerged event. The write is guarded by `updatedAt`,
 * so a replay cannot move a newer row back.
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
import { gitHubPullRequestTerminalEvents } from "../webhooks/events.js";
import {
  loadGitHubPullRequestPeople,
  withGitHubPullRequestPeople,
  type GitHubCommitPageLoader,
  type GitHubPullRequestTarget,
} from "../webhooks/pull-request-people.js";
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

/**
 * Pull requests per GraphQL query. 100 is the GraphQL page size, which keeps
 * the query near one rate limit point and its response small. A repository
 * with more stale open rows uses more queries, so no row waits for others.
 */
const PULL_REQUESTS_PER_QUERY = 100;

const lifecycleSchema = z.object({
  assignees: z.object({
    nodes: z.array(z.object({ login: z.string().min(1) }).nullable()),
  }),
  // GraphQL omits the `[bot]` suffix that REST and webhooks give an app.
  author: z
    .object({ __typename: z.string(), login: z.string().min(1) })
    .nullable(),
  closedAt: z.string().nullable(),
  createdAt: z.string(),
  databaseId: z.number().int().positive(),
  headRefName: z.string(),
  isDraft: z.boolean(),
  merged: z.boolean(),
  mergedAt: z.string().nullable(),
  number: z.number().int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  title: z.string(),
  updatedAt: z.string(),
});

const lifecyclesResponseSchema = z.object({
  data: z.object({
    repository: z
      .object({
        databaseId: z.number().int().positive(),
        nameWithOwner: z.string().min(1),
      })
      // A deleted pull request is null.
      .catchall(lifecycleSchema.nullable()),
  }),
});

interface ReconcileArgs {
  annotations: PluginConversationAnnotations;
  botEmail?: string;
  codeChanges: CodeChangePublisher;
  db: GitHubDb;
  events: EventPublisher;
  /** Read the commits of one pull request, for the people of a merge. */
  loadCommitPages(
    target: GitHubPullRequestTarget,
  ): Promise<GitHubCommitPageLoader>;
  /** Read the lifecycle of some pull requests with one GraphQL query. */
  loadLifecycles(input: {
    numbers: number[];
    repositoryFullName: string;
  }): Promise<unknown>;
  log: Pick<PluginLogger, "error">;
  nowMs: number;
  state: PluginState;
}

/** Write a GraphQL lifecycle as the `closed` webhook body. */
function closedWebhookBody(
  repository: { databaseId: number; nameWithOwner: string },
  pullRequest: z.output<typeof lifecycleSchema>,
) {
  // GitHub shows a deleted account as `ghost`.
  const login = pullRequest.author?.login ?? "ghost";
  return {
    action: "closed",
    pull_request: {
      assignees: pullRequest.assignees.nodes.flatMap((assignee) =>
        assignee ? [{ login: assignee.login }] : [],
      ),
      closed_at: pullRequest.closedAt,
      created_at: pullRequest.createdAt,
      draft: pullRequest.isDraft,
      head: { ref: pullRequest.headRefName },
      id: pullRequest.databaseId,
      merged: pullRequest.merged,
      merged_at: pullRequest.mergedAt,
      number: pullRequest.number,
      title: pullRequest.title,
      updated_at: pullRequest.updatedAt,
      user: {
        login:
          pullRequest.author?.__typename === "Bot" ? `${login}[bot]` : login,
      },
    },
    repository: {
      full_name: repository.nameWithOwner,
      id: repository.databaseId,
    },
  };
}

async function reconcileRepository(
  args: ReconcileArgs,
  repositoryFullName: string,
  numbers: number[],
): Promise<void> {
  for (
    let start = 0;
    start < numbers.length;
    start += PULL_REQUESTS_PER_QUERY
  ) {
    const { databaseId, nameWithOwner, ...pullRequests } =
      lifecyclesResponseSchema.parse(
        await args.loadLifecycles({
          numbers: numbers.slice(start, start + PULL_REQUESTS_PER_QUERY),
          repositoryFullName,
        }),
      ).data.repository;
    for (const pullRequest of Object.values(pullRequests)) {
      if (!pullRequest || pullRequest.state === "OPEN") continue;
      const body = closedWebhookBody(
        { databaseId, nameWithOwner },
        pullRequest,
      );
      const outcome = normalizeGitHubPullRequestOutcome({
        body,
        botEmail: args.botEmail,
      });
      if (!outcome) continue;
      // Publish before the write. When the publish fails, the row stays open
      // and the next reconcile tries again. The events have the key of the
      // webhook events for this close, so a Watch gets the close once.
      // Like the webhook, a merge names the people involved.
      const events = await withGitHubPullRequestPeople({
        body,
        deliveryId: "reconcile",
        events: gitHubPullRequestTerminalEvents(body),
        hasMatch: args.events.hasMatch,
        load: async (target) =>
          await loadGitHubPullRequestPeople({
            logins: target.logins,
            loadPage: await args.loadCommitPages(target),
          }),
        log: args.log,
      });
      for (const event of events) {
        await args.events.publish({ ...event, objectType: "code_change" });
      }
      await applyGitHubPullRequestOutcome({
        annotations: args.annotations,
        codeChanges: args.codeChanges,
        db: args.db,
        log: args.log,
        outcome,
      });
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
