import type {
  PluginConversationAnnotations,
  PluginLogger,
} from "@sentry/junior-plugin-api";
import * as z from "zod";
import type { GitHubDb } from "../db/database.js";
import { githubPreviewImageUrl } from "../object-facts.js";
import { readGitHubPullRequestConversationIds } from "../pull-request-outcomes/store.js";

// These actions carry the current body. `edited` can add or remove an image.
const previewWebhookSchema = z.object({
  action: z.enum(["opened", "edited", "synchronize", "ready_for_review"]),
  pull_request: z.object({
    body: z.string().nullable().optional(),
    id: z.number().int().positive(),
    number: z.number().int().positive(),
    updated_at: z.iso.datetime({ offset: true }),
  }),
  repository: z.object({ full_name: z.string().min(1) }),
});

/**
 * Set or clear the preview image fact on each chip of a Junior pull request
 * from the webhook body. One failed conversation does not stop the others.
 */
export async function refreshGitHubPullRequestPreview(args: {
  annotations: PluginConversationAnnotations;
  body: unknown;
  db: GitHubDb;
  log?: Pick<PluginLogger, "error">;
}): Promise<void> {
  const parsed = previewWebhookSchema.safeParse(args.body);
  if (!parsed.success) return;
  const { pull_request: pullRequest, repository } = parsed.data;
  const conversationIds = await readGitHubPullRequestConversationIds(
    args.db,
    String(pullRequest.id),
  );
  if (conversationIds.length === 0) return;
  const key = `${repository.full_name.toLowerCase()}#${pullRequest.number}`;
  const previewImageUrl = githubPreviewImageUrl(pullRequest.body);
  const updatedAt = Date.parse(pullRequest.updated_at);
  const results = await Promise.allSettled(
    conversationIds.map(async (conversationId) => {
      const store = args.annotations.forConversation(conversationId);
      const current = (await store.list()).find(
        (annotation) => annotation.key === key,
      );
      if (current?.kind !== "object" || current.facts?.type !== "code_change") {
        return;
      }
      // A late delivery must not undo a newer body.
      if (
        current.sourceUpdatedAt &&
        Date.parse(current.sourceUpdatedAt) > updatedAt
      ) {
        return;
      }
      if (current.facts.previewImageUrl === previewImageUrl) return;
      const {
        plugin: _plugin,
        createdAt: _createdAt,
        updatedAt: _updatedAt,
        facts: { previewImageUrl: _previous, ...facts },
        ...annotation
      } = current;
      await store.upsert({
        ...annotation,
        facts: previewImageUrl ? { ...facts, previewImageUrl } : facts,
        sourceUpdatedAt: pullRequest.updated_at,
      });
    }),
  );
  for (const result of results) {
    if (result.status === "fulfilled") continue;
    args.log?.error("GitHub pull request preview update failed", {
      errorType:
        result.reason instanceof Error ? result.reason.name : "UnknownError",
      number: pullRequest.number,
      repository: repository.full_name,
    });
  }
}
