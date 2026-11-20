import * as z from "zod";

const REVIEWS_PAGE_SIZE = 100;

const reviewsSchema = z.array(
  z.object({
    commit_id: z.string().nullable().optional(),
    state: z.string(),
    user: z.object({ login: z.string() }).nullable(),
  }),
);

/** One review of a pull request, as GitHub lists it. */
export type GitHubPullRequestReview = z.infer<typeof reviewsSchema>[number];

/**
 * Read every page of a pull request's reviews, and return the latest
 * approval, change request, or dismissal of each reviewer by lowercase
 * login. Comments do not count. `readPage` reads the reviews with the given
 * query string.
 */
export async function loadLatestReviews(
  readPage: (query: string) => Promise<unknown>,
): Promise<Map<string, GitHubPullRequestReview>> {
  const latest = new Map<string, GitHubPullRequestReview>();
  // A later page can hold a newer review, so read every page. GitHub lists
  // reviews oldest first.
  for (let page = 1; ; page++) {
    const batch = reviewsSchema.parse(
      // oxlint-disable-next-line no-await-in-loop -- Stop paging at the first short page.
      await readPage(`per_page=${REVIEWS_PAGE_SIZE}&page=${page}`),
    );
    for (const review of batch) {
      if (
        review.user &&
        review.state !== "COMMENTED" &&
        review.state !== "PENDING"
      ) {
        latest.set(review.user.login.toLowerCase(), review);
      }
    }
    if (batch.length < REVIEWS_PAGE_SIZE) return latest;
  }
}
