import * as z from "zod";

const timestampSchema = z.iso.datetime({ offset: true });
const numberSchema = z.number().int().positive();
const repositorySchema = z.object({ id: numberSchema });
const senderSchema = z.object({ type: z.string() });

/** One push, review, or comment by a person on a pull request. */
export interface GitHubPullRequestActivity {
  at: Date;
  number: number;
  repositoryId: string;
}

// Each schema reads one webhook into the same activity shape.
const activitySchemas: Record<
  string,
  z.ZodType<GitHubPullRequestActivity & { senderType: string }>
> = {
  issue_comment: z
    .object({
      action: z.literal("created"),
      comment: z.object({ created_at: timestampSchema }),
      // Only comments on a pull request carry `issue.pull_request`.
      issue: z.object({ number: numberSchema, pull_request: z.object({}) }),
      repository: repositorySchema,
      sender: senderSchema,
    })
    .transform((event) => ({
      at: new Date(event.comment.created_at),
      number: event.issue.number,
      repositoryId: String(event.repository.id),
      senderType: event.sender.type,
    })),
  pull_request: z
    .object({
      action: z.literal("synchronize"),
      pull_request: z.object({
        number: numberSchema,
        updated_at: timestampSchema,
      }),
      repository: repositorySchema,
      sender: senderSchema,
    })
    .transform((event) => ({
      at: new Date(event.pull_request.updated_at),
      number: event.pull_request.number,
      repositoryId: String(event.repository.id),
      senderType: event.sender.type,
    })),
  pull_request_review: z
    .object({
      action: z.literal("submitted"),
      pull_request: z.object({ number: numberSchema }),
      repository: repositorySchema,
      review: z.object({ submitted_at: timestampSchema }),
      sender: senderSchema,
    })
    .transform((event) => ({
      at: new Date(event.review.submitted_at),
      number: event.pull_request.number,
      repositoryId: String(event.repository.id),
      senderType: event.sender.type,
    })),
  pull_request_review_comment: z
    .object({
      action: z.literal("created"),
      comment: z.object({ created_at: timestampSchema }),
      pull_request: z.object({ number: numberSchema }),
      repository: repositorySchema,
      sender: senderSchema,
    })
    .transform((event) => ({
      at: new Date(event.comment.created_at),
      number: event.pull_request.number,
      repositoryId: String(event.repository.id),
      senderType: event.sender.type,
    })),
};

/** Read a person's pull request activity from a webhook, if it has any. */
export function normalizeGitHubPullRequestActivity(input: {
  body: unknown;
  eventName: string;
}): GitHubPullRequestActivity | undefined {
  const schema = Object.hasOwn(activitySchemas, input.eventName)
    ? activitySchemas[input.eventName]
    : undefined;
  const parsed = schema?.safeParse(input.body);
  if (!parsed?.success) return undefined;
  const { senderType, ...activity } = parsed.data;
  // Bots, including Junior's GitHub App, do not count as activity.
  return senderType === "Bot" ? undefined : activity;
}
