import { z } from "zod";
import { githubIssueStateReasonSchema } from "../db/schema.js";
import type {
  GitHubIssueConversationsInput,
  GitHubIssueOutcomeInput,
} from "../issue-outcomes/store.js";
import {
  GITHUB_SESSION_FOOTER_START,
  githubConversationIds,
} from "../tools/footer.js";
import { botLoginFromEmail } from "./ownership.js";

const canonicalIssueOutcomeSchema = z
  .object({
    action: z.enum(["opened", "closed", "reopened"]),
    issue: z
      .object({
        body: z.string().nullable().optional(),
        closed_at: z.string().nullable().optional(),
        created_at: z.string(),
        id: z.number().int().positive(),
        number: z.number().int().positive(),
        state_reason: githubIssueStateReasonSchema.nullable().optional(),
        updated_at: z.string(),
        user: z.object({ login: z.string().min(1) }).strict(),
      })
      .strict(),
    repository: z
      .object({
        full_name: z.string().min(1),
        id: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

const issueOutcomeSchema = z
  .object({
    action: z.enum(["opened", "closed", "reopened"]),
    issue: z
      .object({
        body: z.string().nullable().optional(),
        closed_at: z.string().nullable().optional(),
        created_at: z.string(),
        id: z.number().int().positive(),
        number: z.number().int().positive(),
        state_reason: githubIssueStateReasonSchema.nullable().optional(),
        updated_at: z.string(),
        user: z.object({ login: z.string().min(1) }).passthrough(),
      })
      .passthrough(),
    repository: z
      .object({
        full_name: z.string().min(1),
        id: z.number().int().positive(),
      })
      .passthrough(),
  })
  .passthrough()
  .transform((provider) =>
    canonicalIssueOutcomeSchema.parse({
      action: provider.action,
      issue: {
        body: provider.issue.body,
        closed_at: provider.issue.closed_at,
        created_at: provider.issue.created_at,
        id: provider.issue.id,
        number: provider.issue.number,
        state_reason: provider.issue.state_reason,
        updated_at: provider.issue.updated_at,
        user: { login: provider.issue.user.login },
      },
      repository: {
        full_name: provider.repository.full_name,
        id: provider.repository.id,
      },
    }),
  );

const issueLifecycleActionSchema = z
  .object({ action: z.string() })
  .passthrough();

/** Parse a provider timestamp, rejecting missing or invalid lifecycle values. */
function timestamp(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

/** Normalize only the fields required for the Junior-owned issue projection. */
export function normalizeGitHubIssueOutcome(args: {
  body: unknown;
  botEmail?: string;
}): GitHubIssueOutcomeInput | undefined {
  const lifecycle = issueLifecycleActionSchema.safeParse(args.body);
  if (
    !lifecycle.success ||
    !["opened", "closed", "reopened"].includes(lifecycle.data.action)
  ) {
    return undefined;
  }
  const parsed = issueOutcomeSchema.parse(args.body);
  const issue = parsed.issue;
  const openedAt = timestamp(issue.created_at);
  const updatedAt = timestamp(issue.updated_at);
  if (!openedAt || !updatedAt) {
    throw new Error("GitHub issue lifecycle timestamps are invalid");
  }
  const authorLogin = issue.user.login.trim().toLowerCase();
  const botLogin = botLoginFromEmail(args.botEmail)?.toLowerCase();
  if (parsed.action === "opened" && !botLogin) {
    throw new Error(
      "The configured GitHub App bot email must encode a [bot] login in GitHub's noreply format to classify issue ownership",
    );
  }
  const hasOwnershipMarker = Boolean(
    botLogin &&
    authorLogin === botLogin &&
    issue.body?.includes(GITHUB_SESSION_FOOTER_START),
  );
  const candidateOwned =
    hasOwnershipMarker &&
    (parsed.action === "opened" || parsed.action === "closed");
  const closedAt = timestamp(issue.closed_at);
  if (parsed.action === "closed" && !closedAt) {
    throw new Error("GitHub issue terminal timestamp is invalid");
  }
  return {
    candidateOwned,
    closedAt,
    issueId: String(issue.id),
    number: issue.number,
    openedAt,
    repositoryFullName: parsed.repository.full_name,
    repositoryId: String(parsed.repository.id),
    state: parsed.action === "closed" ? "closed" : "open",
    stateReason:
      parsed.action === "closed" ? (issue.state_reason ?? undefined) : undefined,
    updatedAt,
  };
}

const canonicalIssueConversationSchema = z
  .object({
    issue: z
      .object({
        body: z.string().nullable().optional(),
        id: z.number().int().positive(),
        user: z.object({ login: z.string().min(1) }).strict(),
      })
      .strict(),
    sender: z.object({ login: z.string().min(1) }).strict().optional(),
  })
  .strict();

const issueConversationSchema = z
  .object({
    issue: z
      .object({
        body: z.string().nullable().optional(),
        id: z.number().int().positive(),
        user: z.object({ login: z.string().min(1) }).passthrough(),
      })
      .passthrough(),
    sender: z.object({ login: z.string().min(1) }).passthrough().optional(),
  })
  .passthrough()
  .transform((provider) =>
    canonicalIssueConversationSchema.parse({
      issue: {
        body: provider.issue.body,
        id: provider.issue.id,
        user: { login: provider.issue.user.login },
      },
      ...(provider.sender
        ? { sender: { login: provider.sender.login } }
        : undefined),
    }),
  );

/** Normalize native conversation ids written to a Junior-owned issue by its bot. */
export function normalizeGitHubIssueConversations(args: {
  body: unknown;
  botEmail?: string;
}): GitHubIssueConversationsInput | undefined {
  const parsed = issueConversationSchema.safeParse(args.body);
  const botLogin = botLoginFromEmail(args.botEmail)?.toLowerCase();
  if (!parsed.success || !botLogin) return undefined;
  const authorLogin = parsed.data.issue.user.login.trim().toLowerCase();
  if (authorLogin !== botLogin) return undefined;
  const senderLogin = parsed.data.sender?.login.trim().toLowerCase();
  if (senderLogin && senderLogin !== botLogin) return undefined;
  const conversationIds = githubConversationIds(parsed.data.issue.body);
  return conversationIds.length > 0
    ? {
        conversationIds,
        issueId: String(parsed.data.issue.id),
      }
    : undefined;
}
