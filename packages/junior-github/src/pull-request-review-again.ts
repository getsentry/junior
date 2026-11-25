/**
 * Whether a reviewer's change request on a Junior pull request is ready for
 * their review again.
 *
 * Only an explicit signal asks again: Junior marks every comment of the
 * reviewer's latest change request addressed or declined with the feedback
 * tool. Pushes, base-branch syncs, comments, and replies never ask on their
 * own. The ask also waits until the required checks of the head commit pass.
 * GitHub sends no webhook for a reaction, so the feedback tool reads this
 * when it marks a comment. When the checks have not passed yet, it saves a
 * held ask, and the check suite webhook reads this again.
 */
import type { PluginState } from "@sentry/junior-plugin-api";
import * as z from "zod";
import {
  PULL_REQUEST_REQUIRED_CHECKS,
  PULL_REQUEST_REVIEW_AGAIN,
} from "./graphql-documents.js";

/**
 * One GitHub API read: a GraphQL query when `body` is set, else a REST GET.
 * It returns the response body and throws when GitHub rejects the read.
 */
export type GitHubRead = (request: {
  body?: unknown;
  operation: string;
  path: string;
}) => Promise<unknown>;

/**
 * `ready`: ask the reviewer again now. `checks`: every comment is marked,
 * but the required checks have not passed. `none`: do not ask, because
 * GitHub already asks them, their latest review is not a change request, or
 * a comment of it is not marked.
 */
export type ReviewAgainReadiness = "checks" | "none" | "ready";

const reactorsSchema = z.object({
  reactionGroups: z.array(
    z.object({
      content: z.string(),
      reactors: z.object({
        nodes: z.array(
          z.object({ databaseId: z.number().optional() }).nullable(),
        ),
      }),
    }),
  ),
});

const checkContextSchema = z.discriminatedUnion("__typename", [
  z.object({
    __typename: z.literal("CheckRun"),
    conclusion: z.string().nullable(),
    name: z.string(),
    status: z.string(),
  }),
  z.object({
    __typename: z.literal("StatusContext"),
    context: z.string(),
    state: z.string(),
  }),
]);

// The fields of the `RequiredChecks` GraphQL fragment.
const requiredChecksSchema = z.object({
  baseRef: z
    .object({
      refUpdateRule: z
        .object({
          requiredStatusCheckContexts: z
            .array(z.string().nullable())
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
  baseRefName: z.string().min(1),
  commits: z.object({
    nodes: z.array(
      z.object({
        commit: z.object({
          statusCheckRollup: z
            .object({
              contexts: z.object({
                nodes: z.array(checkContextSchema.nullable()),
                pageInfo: z.object({ hasNextPage: z.boolean() }),
              }),
            })
            .nullable(),
        }),
      }),
    ),
  }),
});

const requiredChecksReadSchema = z.object({
  data: z.object({
    repository: z.object({ pullRequest: requiredChecksSchema }),
  }),
});

const reviewAgainSchema = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: requiredChecksSchema.extend({
        reviewRequests: z.object({
          nodes: z.array(
            z
              .object({
                requestedReviewer: z
                  .object({
                    __typename: z.string(),
                    login: z.string().optional(),
                  })
                  .nullable(),
              })
              .nullable(),
          ),
        }),
        reviews: z.object({
          nodes: z.array(
            reactorsSchema
              .extend({
                body: z.string(),
                comments: z.object({
                  nodes: z.array(
                    reactorsSchema
                      .extend({ databaseId: z.number().nullable() })
                      .nullable(),
                  ),
                  totalCount: z.number(),
                }),
                databaseId: z.number().nullable(),
                state: z.string(),
              })
              .nullable(),
          ),
        }),
      }),
    }),
  }),
});

// Rulesets that apply to a branch. Only status check rules matter here.
const branchRulesSchema = z.array(
  z.object({
    parameters: z
      .object({
        required_status_checks: z
          .array(z.object({ context: z.string() }))
          .optional(),
      })
      .optional(),
    type: z.string(),
  }),
);

// The reactions that mark a comment addressed or declined, by GraphQL name.
const MARKED_CONTENTS = new Set(["THUMBS_DOWN", "THUMBS_UP"]);

// A check run that completed with one of these conclusions does not block a
// merge. Every other conclusion does.
const PASSING_CONCLUSIONS = new Set(["NEUTRAL", "SKIPPED", "SUCCESS"]);

type CheckContext = z.output<typeof checkContextSchema>;

/** Return whether one check run or commit status passes, fails, or waits. */
export function checkContextState(
  context: CheckContext,
): "failing" | "passing" | "pending" {
  if (context.__typename === "CheckRun") {
    if (context.status !== "COMPLETED") return "pending";
    return PASSING_CONCLUSIONS.has(context.conclusion ?? "")
      ? "passing"
      : "failing";
  }
  if (context.state === "SUCCESS") return "passing";
  return context.state === "PENDING" || context.state === "EXPECTED"
    ? "pending"
    : "failing";
}

function markedBy(
  reactable: z.output<typeof reactorsSchema>,
  botUserId: number,
): boolean {
  return reactable.reactionGroups.some(
    (group) =>
      MARKED_CONTENTS.has(group.content) &&
      group.reactors.nodes.some((reactor) => reactor?.databaseId === botUserId),
  );
}

/**
 * Return whether every required check passes. A required check that has
 * not reported yet waits, so the ask does not go out before CI starts.
 */
function requiredChecksPass(
  required: Set<string>,
  contexts: CheckContext[],
  incomplete: boolean,
): boolean {
  for (const name of required) {
    const states = contexts
      .filter(
        (context) =>
          (context.__typename === "CheckRun"
            ? context.name
            : context.context) === name,
      )
      .map(checkContextState);
    // More than 100 checks hide some, so a missing check can still exist.
    if (states.length === 0 && incomplete) return false;
    if (states.length === 0 || states.some((state) => state !== "passing")) {
      return false;
    }
  }
  return true;
}

/**
 * Read whether `reviewer`'s latest change request on a pull request is
 * ready for their review again. The comments of a change request are its
 * inline comments and its body. An empty body counts only when the review
 * has no inline comments.
 */
export async function readReviewAgainReadiness(
  read: GitHubRead,
  target: {
    botUserId: number;
    /**
     * The comment that the caller just marked. It counts as marked, because
     * GitHub's GraphQL read can lag behind a reaction that was just added.
     */
    marked?: { id: number; kind: "review" | "review_body" } | undefined;
    name: string;
    number: number;
    owner: string;
    reviewer: string;
  },
): Promise<ReviewAgainReadiness> {
  const { name, number, owner, reviewer } = target;
  const pull = reviewAgainSchema.parse(
    await read({
      body: {
        ...PULL_REQUEST_REVIEW_AGAIN,
        variables: { name, number, owner, reviewer },
      },
      operation: "github.pull.review-again.get",
      path: "/graphql",
    }),
  ).data.repository.pullRequest;
  const lower = reviewer.toLowerCase();
  const requested = pull.reviewRequests.nodes.some(
    (request) => request?.requestedReviewer?.login?.toLowerCase() === lower,
  );
  const review = pull.reviews.nodes[0];
  if (requested || review?.state !== "CHANGES_REQUESTED") return "none";
  const comments = review.comments.nodes.filter((comment) => comment !== null);
  // A comment past the first 100 cannot be read, so it counts as open.
  if (comments.length < review.comments.totalCount) return "none";
  const { marked } = target;
  const justMarked = (id: number | null, kind: "review" | "review_body") =>
    marked?.kind === kind && marked.id === id;
  const bodyMarked =
    justMarked(review.databaseId, "review_body") ||
    markedBy(review, target.botUserId);
  const bodyCounts = review.body.trim() !== "" || comments.length === 0;
  if (bodyCounts && !bodyMarked) return "none";
  const commentsMarked = comments.every(
    (comment) =>
      justMarked(comment.databaseId, "review") ||
      markedBy(comment, target.botUserId),
  );
  if (!commentsMarked) return "none";
  return (await readRequiredChecksPass(read, target, pull))
    ? "ready"
    : "checks";
}

async function readRequiredChecksPass(
  read: GitHubRead,
  target: { name: string; owner: string },
  pull: z.output<typeof requiredChecksSchema>,
): Promise<boolean> {
  const { name, owner } = target;
  const rules = branchRulesSchema.parse(
    await read({
      operation: "github.repo.branch-rules.get",
      path: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/rules/branches/${encodeURIComponent(pull.baseRefName)}?per_page=100`,
    }),
  );
  const required = new Set<string>([
    ...(pull.baseRef?.refUpdateRule?.requiredStatusCheckContexts ?? []).filter(
      (context): context is string => Boolean(context),
    ),
    ...rules.flatMap((rule) =>
      rule.type === "required_status_checks"
        ? (rule.parameters?.required_status_checks ?? []).map(
            (check) => check.context,
          )
        : [],
    ),
  ]);
  const rollup = pull.commits.nodes[0]?.commit.statusCheckRollup;
  const contexts = (rollup?.contexts.nodes ?? []).filter(
    (context) => context !== null,
  );
  return requiredChecksPass(
    required,
    contexts,
    rollup?.contexts.pageInfo.hasNextPage ?? false,
  );
}

/**
 * Read whether every required check of a pull request's head commit
 * passes, so an ask for a review does not go out before CI is green.
 */
export async function readGitHubRequiredChecksPass(
  read: GitHubRead,
  target: { name: string; number: number; owner: string },
): Promise<boolean> {
  const { name, number, owner } = target;
  const pull = requiredChecksReadSchema.parse(
    await read({
      body: {
        ...PULL_REQUEST_REQUIRED_CHECKS,
        variables: { name, number, owner },
      },
      operation: "github.pull.required-checks.get",
      path: "/graphql",
    }),
  ).data.repository.pullRequest;
  return await readRequiredChecksPass(read, target, pull);
}

// A held ask waits for the checks of one fix, which take hours at most.
// After this time, only a new mark asks.
const HELD_ASK_TTL_MS = 3 * 24 * 60 * 60 * 1000;

const heldAskSchema = z.object({
  at: z.iso.datetime(),
  // `handled`: the checks passed, but GitHub did not take the request.
  reason: z.enum(["checks", "handled"]),
  reviewer: z.string().min(1),
  // The comment whose mark made the ask, so a lagging read still counts it.
  marked: z
    .object({ id: z.number(), kind: z.enum(["review", "review_body"]) })
    .optional(),
});

/** A review ask that waits for the required checks to pass. */
export type GitHubHeldReviewAsk = z.output<typeof heldAskSchema>;

function heldAskKey(target: {
  number: number;
  repositoryFullName: string;
}): string {
  return `pull-request-review-again:${target.repositoryFullName.toLowerCase()}#${target.number}`;
}

/** Save the review ask that waits for the checks of one pull request. */
export async function holdGitHubReviewAsk(
  state: PluginState,
  target: { number: number; repositoryFullName: string },
  ask: GitHubHeldReviewAsk,
): Promise<void> {
  await state.set(
    heldAskKey(target),
    heldAskSchema.parse(ask),
    HELD_ASK_TTL_MS,
  );
}

/** Return the review ask that waits for the checks of one pull request. */
export async function readHeldGitHubReviewAsk(
  state: PluginState,
  target: { number: number; repositoryFullName: string },
): Promise<GitHubHeldReviewAsk | undefined> {
  const saved = heldAskSchema.safeParse(await state.get(heldAskKey(target)));
  return saved.success ? saved.data : undefined;
}

/**
 * Drop the held review ask of one pull request. With `reviewer`, drop it
 * only when it is for that reviewer.
 */
export async function dropHeldGitHubReviewAsk(
  state: PluginState,
  target: { number: number; repositoryFullName: string },
  reviewer?: string,
): Promise<void> {
  if (reviewer !== undefined) {
    const held = await readHeldGitHubReviewAsk(state, target);
    if (held?.reviewer.toLowerCase() !== reviewer.toLowerCase()) return;
  }
  await state.delete(heldAskKey(target));
}

/**
 * Why Junior asked a reviewer: `handled` when the last comment was marked
 * and the checks already passed, `checks` when passing checks released a
 * held ask, `question` when a Junior comment asked the requester.
 */
export type GitHubReviewAskReason = "checks" | "handled" | "question";

// The tool asks on GitHub, and GitHub's review request webhook shows the
// item. The mark only needs to outlive that delivery.
const ASKED_TTL_MS = 60 * 60 * 1000;

const askedSchema = z.object({
  at: z.iso.datetime(),
  // Unset means `handled`.
  reason: z.enum(["handled", "question"]).optional(),
  reviewer: z.string().min(1),
});

/** A review that a Junior tool asked for, until the item shows it. */
export type GitHubReviewAsked = z.output<typeof askedSchema>;

function askedKey(target: {
  number: number;
  repositoryFullName: string;
}): string {
  return `pull-request-review-asked:${target.repositoryFullName.toLowerCase()}#${target.number}`;
}

/** Record that a Junior tool asked `reviewer` on one pull request. */
export async function markGitHubReviewAsked(
  state: PluginState,
  target: { number: number; repositoryFullName: string },
  asked: GitHubReviewAsked,
): Promise<void> {
  await state.set(askedKey(target), askedSchema.parse(asked), ASKED_TTL_MS);
}

/** Return the review that a Junior tool asked for on one pull request. */
export async function readGitHubReviewAsked(
  state: PluginState,
  target: { number: number; repositoryFullName: string },
): Promise<GitHubReviewAsked | undefined> {
  const saved = askedSchema.safeParse(await state.get(askedKey(target)));
  return saved.success ? saved.data : undefined;
}

/** Drop the record of a review that a Junior tool asked for. */
export async function dropGitHubReviewAsked(
  state: PluginState,
  target: { number: number; repositoryFullName: string },
): Promise<void> {
  await state.delete(askedKey(target));
}
