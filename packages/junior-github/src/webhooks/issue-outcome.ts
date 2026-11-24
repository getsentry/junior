import * as z from "zod";
import { githubConversationIds } from "../conversation-footer.js";
import { isBotLogin } from "./ownership.js";

const canonicalClosedIssueSchema = z
  .object({
    action: z.string(),
    issue: z
      .object({
        body: z.string().nullable().optional(),
        number: z.number().int().positive(),
        user: z.object({ login: z.string().min(1) }).strict(),
      })
      .strict(),
    repository: z.object({ full_name: z.string().min(1) }).strict(),
  })
  .strict();

const closedIssueSchema = z
  .object({
    action: z.string(),
    issue: z
      .object({
        body: z.string().nullable().optional(),
        number: z.number().int().positive(),
        user: z.object({ login: z.string().min(1) }).passthrough(),
      })
      .passthrough(),
    repository: z.object({ full_name: z.string().min(1) }).passthrough(),
  })
  .passthrough()
  .transform((provider) =>
    canonicalClosedIssueSchema.parse({
      action: provider.action,
      issue: {
        body: provider.issue.body,
        number: provider.issue.number,
        user: { login: provider.issue.user.login },
      },
      repository: { full_name: provider.repository.full_name },
    }),
  );

/**
 * Read a closed Junior issue from an `issues` webhook: the issue, and the
 * Conversations that its bot-written footer names. Undefined for any other
 * action or issue.
 */
export function normalizeGitHubClosedIssue(args: {
  body: unknown;
  botEmail?: string | undefined;
}):
  | { conversationIds: string[]; number: number; repositoryFullName: string }
  | undefined {
  const parsed = closedIssueSchema.safeParse(args.body);
  if (!parsed.success || parsed.data.action !== "closed") return undefined;
  const { issue, repository } = parsed.data;
  if (!isBotLogin(issue.user.login, args.botEmail)) return undefined;
  const conversationIds = githubConversationIds(issue.body);
  return conversationIds.length > 0
    ? {
        conversationIds,
        number: issue.number,
        repositoryFullName: repository.full_name,
      }
    : undefined;
}
