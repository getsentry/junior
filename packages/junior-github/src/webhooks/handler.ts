import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  PluginConversationAnnotations,
  PluginLogger,
  PluginRoute,
  ResourceEventPublisher,
} from "@sentry/junior-plugin-api";
import type { GitHubDb } from "../db/database.js";
import type { GitHubPullRequestCommitComposition } from "../db/schema.js";
import {
  recordGitHubIssueConversations,
  recordGitHubIssueOutcome,
} from "../issue-outcomes/store.js";
import {
  recordGitHubPullRequestConversations,
  recordGitHubPullRequestLinkedIssues,
  recordGitHubPullRequestOutcome,
} from "../pull-request-outcomes/store.js";
import {
  normalizeGitHubIssueConversations,
  normalizeGitHubIssueOutcome,
} from "./issue-outcome.js";
import {
  normalizeGitHubPullRequestConversations,
  normalizeGitHubPullRequestLinkedIssues,
  normalizeGitHubPullRequestOutcome,
} from "./pull-request-outcome.js";
import {
  normalizeGitHubResourceEvents,
  type GitHubFailingCheck,
} from "./resource-events.js";

/** Verify GitHub's SHA-256 signature against the untouched request body. */
function verifyGitHubSignature(
  body: string,
  signature: string,
  secret: string | undefined,
): boolean {
  if (!secret || !signature.startsWith("sha256=")) return false;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
  );
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Convert malformed signed bodies into an unusable webhook payload. */
function parseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

/** Parse one exact positive GitHub App installation ID. */
function parseInstallationId(value: unknown): number | undefined {
  const parsed =
    typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  return typeof parsed === "number" &&
    Number.isSafeInteger(parsed) &&
    parsed > 0
    ? parsed
    : undefined;
}

/** Read the GitHub App installation that owns one verified webhook payload. */
function webhookInstallationId(body: unknown): number | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return undefined;
  }
  const installation = (body as { installation?: unknown }).installation;
  if (
    !installation ||
    typeof installation !== "object" ||
    Array.isArray(installation)
  ) {
    return undefined;
  }
  return parseInstallationId((installation as { id?: unknown }).id);
}

/** Create the public, signed GitHub webhook route owned by the plugin. */
export function createGitHubWebhookRoute(args: {
  annotations: PluginConversationAnnotations;
  botEmail(): string | undefined;
  classifyPullRequestCommits?(input: {
    number: number;
    repositoryFullName: string;
  }): Promise<GitHubPullRequestCommitComposition | undefined>;
  db: GitHubDb;
  installationId(): string | undefined;
  loadFailingChecks?(body: unknown): Promise<GitHubFailingCheck[] | undefined>;
  log?: Pick<PluginLogger, "error">;
  resourceEvents: ResourceEventPublisher;
  webhookSecret(): string | undefined;
}): PluginRoute {
  return {
    method: "POST",
    path: "/api/webhooks/github",
    async handler(request) {
      const rawBody = await request.text();
      const signature = request.headers.get("x-hub-signature-256") ?? "";
      if (!verifyGitHubSignature(rawBody, signature, args.webhookSecret())) {
        return new Response("Unauthorized", { status: 401 });
      }
      const deliveryId = request.headers.get("x-github-delivery");
      const eventName = request.headers.get("x-github-event");
      if (!deliveryId || !eventName) {
        return new Response("Malformed GitHub webhook", { status: 400 });
      }

      const body = parseJson(rawBody);
      const installationId = parseInstallationId(args.installationId());
      if (!installationId) {
        return new Response("GitHub webhook installation is not configured", {
          status: 503,
        });
      }
      if (webhookInstallationId(body) !== installationId) {
        return new Response("Ignored", { status: 202 });
      }
      const botEmail = args.botEmail();
      const pullRequestOutcome =
        eventName === "pull_request"
          ? normalizeGitHubPullRequestOutcome({ body, botEmail })
          : undefined;
      const issueOutcome =
        eventName === "issues"
          ? normalizeGitHubIssueOutcome({ body, botEmail })
          : undefined;
      const issueConversations =
        eventName === "issues"
          ? normalizeGitHubIssueConversations({ body, botEmail })
          : undefined;
      const pullRequestConversations =
        eventName === "pull_request"
          ? normalizeGitHubPullRequestConversations({ body, botEmail })
          : undefined;
      const pullRequestLinkedIssues =
        eventName === "pull_request"
          ? normalizeGitHubPullRequestLinkedIssues({ body, botEmail })
          : undefined;
      if (pullRequestOutcome) {
        const recordedOutcome = await recordGitHubPullRequestOutcome(
          args.db,
          pullRequestOutcome,
        );
        if (recordedOutcome.applied && pullRequestOutcome.state !== "open") {
          const status =
            pullRequestOutcome.state === "merged" ? "merged" : "closed";
          await Promise.all(
            recordedOutcome.conversationIds.map((conversationId) =>
              args.annotations.forConversation(conversationId).upsert({
                kind: "resource_link",
                key: `${pullRequestOutcome.repositoryFullName.toLowerCase()}#${pullRequestOutcome.number}`,
                label: `${pullRequestOutcome.repositoryFullName}#${pullRequestOutcome.number}`,
                url: `https://github.com/${pullRequestOutcome.repositoryFullName}/pull/${pullRequestOutcome.number}`,
                status,
              }),
            ),
          );
        }
        if (
          recordedOutcome.applied &&
          !recordedOutcome.commitComposition &&
          pullRequestOutcome.state === "merged" &&
          args.classifyPullRequestCommits
        ) {
          let commitComposition: GitHubPullRequestCommitComposition | undefined;
          try {
            commitComposition = await args.classifyPullRequestCommits({
              number: pullRequestOutcome.number,
              repositoryFullName: pullRequestOutcome.repositoryFullName,
            });
          } catch (error) {
            args.log?.error("GitHub PR commit classification failed", {
              deliveryId,
              errorType: error instanceof Error ? error.name : "UnknownError",
              number: pullRequestOutcome.number,
              repository: pullRequestOutcome.repositoryFullName,
            });
          }
          if (commitComposition) {
            await recordGitHubPullRequestOutcome(args.db, {
              ...pullRequestOutcome,
              commitComposition,
            });
          }
        }
      }
      if (issueOutcome) {
        const recordedOutcome = await recordGitHubIssueOutcome(
          args.db,
          issueOutcome,
        );
        if (recordedOutcome.applied && issueOutcome.state === "closed") {
          await Promise.all(
            recordedOutcome.conversationIds.map((conversationId) =>
              args.annotations.forConversation(conversationId).upsert({
                kind: "resource_link",
                key: `${issueOutcome.repositoryFullName.toLowerCase()}#${issueOutcome.number}`,
                label: `${issueOutcome.repositoryFullName}#${issueOutcome.number}`,
                url: `https://github.com/${issueOutcome.repositoryFullName}/issues/${issueOutcome.number}`,
                status: "closed",
              }),
            ),
          );
        }
      }
      const recordedIssueConversations = issueConversations
        ? await recordGitHubIssueConversations(args.db, issueConversations)
        : false;
      const recordedPullRequestConversations = pullRequestConversations
        ? await recordGitHubPullRequestConversations(
            args.db,
            pullRequestConversations,
          )
        : false;
      const recordedPullRequestLinkedIssues = pullRequestLinkedIssues
        ? await recordGitHubPullRequestLinkedIssues(
            args.db,
            pullRequestLinkedIssues,
          )
        : false;

      const failingChecks =
        eventName === "check_suite" && args.loadFailingChecks
          ? await args.loadFailingChecks(body)
          : undefined;
      const resourceEvents = normalizeGitHubResourceEvents({
        body,
        deliveryId,
        eventName,
        failingChecks,
      });
      for (const event of resourceEvents) {
        await args.resourceEvents.publish(event);
      }
      if (
        !pullRequestOutcome &&
        !issueOutcome &&
        !recordedIssueConversations &&
        !recordedPullRequestConversations &&
        !recordedPullRequestLinkedIssues &&
        resourceEvents.length === 0
      ) {
        return new Response("Ignored", { status: 202 });
      }
      return new Response("Accepted", { status: 202 });
    },
  };
}
