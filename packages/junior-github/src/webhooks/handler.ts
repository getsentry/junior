import { updateGitHubAnnotation } from "../annotations.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import type {
  CodeChangeInput,
  CodeChangePublisher,
  PluginConversationAnnotations,
  PluginLogger,
  PluginRoute,
  EventInput,
  EventPublisher,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { GitHubDb } from "../db/database.js";
import type { GitHubPullRequestCommitComposition } from "../db/schema.js";
import {
  removeGitHubInstallation,
  saveGitHubInstallation,
} from "../installations/store.js";
import {
  recordGitHubIssueConversations,
  recordGitHubIssueOutcome,
} from "../issue-outcomes/store.js";
import {
  type GitHubPullRequestOutcomeInput,
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
  loadCheckSuiteFacts,
  needsCheckSuitePullRequestFacts,
  parseCheckSuitePublishTargets,
} from "./check-suite.js";
import { normalizeGitHubEvents } from "./events.js";
import {
  withGitHubPullRequestMatchData,
  type GitHubRoleTarget,
} from "./pull-request-match-data.js";
import {
  loadGitHubPullRequestAuthors,
  loadGitHubPullRequestPeople,
  shareCommitPages,
  withGitHubPullRequestPeople,
  type GitHubCommitPageLoader,
  type GitHubPullRequestTarget,
} from "./pull-request-people.js";

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

const installationEventSchema = z.object({
  action: z.string(),
  /** Set on `installation_target` deliveries, with the new login. */
  account: z.object({ login: z.string().min(1) }).optional(),
  installation: z.object({
    account: z.object({ login: z.string().min(1) }).optional(),
  }),
});

/**
 * Keep the stored installations current. Installs, permission changes, and
 * unsuspends save the account login. Uninstalls and suspends mark the row as
 * removed, because GitHub cannot mint tokens for them. Account renames arrive as
 * `installation_target` deliveries.
 */
async function recordInstallationEvent(
  db: GitHubDb,
  eventName: "installation" | "installation_target",
  installationId: number,
  body: unknown,
): Promise<void> {
  const parsed = installationEventSchema.safeParse(body);
  if (!parsed.success) return;
  const { account, action, installation } = parsed.data;
  if (
    eventName === "installation" &&
    (action === "deleted" || action === "suspend")
  ) {
    await removeGitHubInstallation(db, installationId);
    return;
  }
  const accountLogin =
    eventName === "installation_target"
      ? account?.login
      : installation.account?.login;
  if (accountLogin) {
    await saveGitHubInstallation(db, { accountLogin, installationId });
  }
}

/** The pull request comment data that the feedback reaction needs. */
const feedbackTargetSchema = z.object({
  commentId: z.number(),
  commentKind: z.enum(["conversation", "review"]),
  repo: z.string().min(1),
});
type FeedbackTarget = z.output<typeof feedbackTargetSchema>;

/** A webhook lookup target with the installation that sent the delivery. */
type InstallationScoped<T> = T & { installationId: number };

/** Return comment-level pull request feedback that the webhook can mark. */
function pullRequestFeedbackTarget(
  events: EventInput[],
): FeedbackTarget | undefined {
  const event = events.find(
    (candidate) =>
      candidate.eventType === "pull_request.comment.created" ||
      candidate.eventType === "pull_request.review_comment.created",
  );
  const parsed = feedbackTargetSchema.safeParse(event?.data);
  return parsed.success ? parsed.data : undefined;
}

function githubCodeChange(
  outcome: GitHubPullRequestOutcomeInput,
  conversationIds: string[],
): CodeChangeInput {
  return {
    closedAt: outcome.closedAt,
    conversationIds,
    mergedAt: outcome.mergedAt,
    number: outcome.number,
    openedAt: outcome.openedAt,
    providerId: outcome.pullRequestId,
    repository: {
      name: outcome.repositoryFullName,
      providerId: outcome.repositoryId,
      url: `https://github.com/${outcome.repositoryFullName}`,
    },
    state: outcome.state === "closed_unmerged" ? "closed" : outcome.state,
    title: outcome.title,
    updatedAt: outcome.updatedAt,
    url: `https://github.com/${outcome.repositoryFullName}/pull/${outcome.number}`,
  };
}

/** Create the public, signed GitHub webhook route owned by the plugin. */
export function createGitHubWebhookRoute(args: {
  annotations: PluginConversationAnnotations;
  appIdEnv: string;
  botEmail(): string | undefined;
  classifyPullRequestCommits?(
    input: InstallationScoped<GitHubPullRequestTarget>,
  ): Promise<GitHubPullRequestCommitComposition | undefined>;
  codeChanges: CodeChangePublisher;
  db: GitHubDb;
  /**
   * Read a pull request's commits for the `authors` field and the people
   * involved.
   */
  loadPullRequestCommitPages?(
    target: InstallationScoped<GitHubPullRequestTarget>,
  ): Promise<GitHubCommitPageLoader>;
  /** Load a repository role for `openerRole`. */
  loadRepositoryRole?(
    target: InstallationScoped<GitHubRoleTarget>,
  ): Promise<string>;
  /** Linked GitHub login of the user of one Junior identity, if any. */
  loadGitHubLogin?(identityId: string): Promise<string | undefined>;
  log?: Pick<PluginLogger, "error">;
  markFeedbackReviewing(
    input: InstallationScoped<FeedbackTarget>,
  ): Promise<void>;
  privateKeyEnv: string;
  events: EventPublisher;
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
      // The signature proves the delivery is for this App, from any of its
      // installations. Every token for this delivery uses that installation.
      const installationId = webhookInstallationId(body);
      if (!installationId) {
        return new Response("Ignored", { status: 202 });
      }
      if (eventName === "installation" || eventName === "installation_target") {
        await recordInstallationEvent(args.db, eventName, installationId, body);
        return new Response("Accepted", { status: 202 });
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
        if (recordedOutcome.applied) {
          await args.codeChanges.record(
            githubCodeChange(
              pullRequestOutcome,
              recordedOutcome.conversationIds,
            ),
          );
        }
        if (recordedOutcome.applied && pullRequestOutcome.state !== "open") {
          const status =
            pullRequestOutcome.state === "merged" ? "merged" : "closed";
          await Promise.all(
            recordedOutcome.conversationIds.map((conversationId) =>
              updateGitHubAnnotation(
                args.annotations.forConversation(conversationId),
                {
                  repo: pullRequestOutcome.repositoryFullName,
                  number: pullRequestOutcome.number,
                  objectType: "code_change",
                  status,
                },
              ),
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
              installationId,
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
              updateGitHubAnnotation(
                args.annotations.forConversation(conversationId),
                {
                  repo: issueOutcome.repositoryFullName,
                  number: issueOutcome.number,
                  objectType: "task",
                  status: "closed",
                },
              ),
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
      if (recordedPullRequestConversations && pullRequestConversations) {
        await args.codeChanges.associateConversations({
          conversationIds: pullRequestConversations.conversationIds,
          providerId: pullRequestConversations.pullRequestId,
        });
      }
      const recordedPullRequestLinkedIssues = pullRequestLinkedIssues
        ? await recordGitHubPullRequestLinkedIssues(
            args.db,
            pullRequestLinkedIssues,
          )
        : false;

      const checkSuitePublishTargets =
        eventName === "check_suite"
          ? parseCheckSuitePublishTargets(body)
          : undefined;
      const checkSuiteMatchKeys =
        checkSuitePublishTargets && args.events.neededMatchKeys
          ? await args.events.neededMatchKeys(checkSuitePublishTargets)
          : [];
      const checkSuiteFacts =
        eventName === "check_suite"
          ? await loadCheckSuiteFacts({
              appIdEnv: args.appIdEnv,
              body,
              installationId,
              loadPullRequestFacts:
                needsCheckSuitePullRequestFacts(checkSuiteMatchKeys),
              log: args.log,
              privateKeyEnv: args.privateKeyEnv,
            })
          : undefined;
      const hasMatch = args.events.hasMatch;
      const loadCommitPages = args.loadPullRequestCommitPages;
      const commitPages = loadCommitPages
        ? shareCommitPages(
            async (target) =>
              await loadCommitPages({ ...target, installationId }),
          )
        : undefined;
      const loadRepositoryRole = args.loadRepositoryRole;
      const events = await withGitHubPullRequestPeople({
        body,
        deliveryId,
        events: await withGitHubPullRequestMatchData({
          body,
          botEmail,
          db: args.db,
          deliveryId,
          events: normalizeGitHubEvents({
            body,
            botEmail,
            ...(checkSuiteFacts ? { checkSuiteFacts } : undefined),
            deliveryId,
            eventName,
          }),
          hasMatch,
          ...(commitPages
            ? {
                loadAuthors: async (target: GitHubPullRequestTarget) =>
                  await loadGitHubPullRequestAuthors({
                    loadPage: commitPages(target),
                  }),
              }
            : undefined),
          loadGitHubLogin: args.loadGitHubLogin,
          loadRole: loadRepositoryRole
            ? async (target) =>
                await loadRepositoryRole({ ...target, installationId })
            : undefined,
          log: args.log,
          neededMatchKeys: args.events.neededMatchKeys,
        }),
        hasMatch,
        ...(commitPages
          ? {
              load: async (target) =>
                await loadGitHubPullRequestPeople({
                  logins: target.logins,
                  loadPage: commitPages(target),
                }),
            }
          : undefined),
        log: args.log,
      });
      const feedbackTarget = pullRequestFeedbackTarget(events);
      const feedbackHasMatch =
        feedbackTarget && hasMatch
          ? (await Promise.all(events.map((event) => hasMatch(event)))).some(
              Boolean,
            )
          : false;
      if (feedbackTarget && feedbackHasMatch) {
        try {
          await args.markFeedbackReviewing({
            ...feedbackTarget,
            installationId,
          });
        } catch (error) {
          args.log?.error("GitHub pull request feedback reaction failed", {
            commentId: feedbackTarget.commentId,
            deliveryId,
            errorType: error instanceof Error ? error.name : "UnknownError",
            repository: feedbackTarget.repo,
          });
        }
      }
      for (const event of events) {
        await args.events.publish({
          ...event,
          objectType: event.eventType.startsWith("pull_request.")
            ? "code_change"
            : event.eventType.startsWith("issue.")
              ? "task"
              : event.eventType.startsWith("deployment.")
                ? "deployment"
                : "item",
        });
      }
      if (
        !pullRequestOutcome &&
        !issueOutcome &&
        !recordedIssueConversations &&
        !recordedPullRequestConversations &&
        !recordedPullRequestLinkedIssues &&
        events.length === 0
      ) {
        return new Response("Ignored", { status: 202 });
      }
      return new Response("Accepted", { status: 202 });
    },
  };
}
