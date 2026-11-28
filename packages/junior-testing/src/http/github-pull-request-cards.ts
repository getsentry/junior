// The GitHub plugin reads pull request cards and head facts with one aliased
// query: pull request `i` is `p<i>`, with the variables `owner<i>`,
// `name<i>`, and `number<i>` (`junior-github/src/graphql-documents.ts`).
// A check event for a pull request with no cache entry reads its card.
const ALIASED_OPERATIONS = new Set([
  "PullRequestCards",
  "PullRequestHeadFacts",
]);

/**
 * Answer an aliased card or head-facts query of getsentry/junior with the
 * card that `cardOf` returns for each number. Return undefined for another
 * query, or when `cardOf` knows none of its pull requests, so another
 * fixture can answer it.
 */
export function pullRequestCardsResponse(
  body: { operationName?: string; variables?: Record<string, unknown> },
  cardOf: (number: number) => object | undefined,
): Response | undefined {
  if (!ALIASED_OPERATIONS.has(body.operationName ?? "")) return undefined;
  const variables = body.variables ?? {};
  const data: Record<string, { pullRequest: object } | null> = {};
  let known = false;
  for (let index = 0; `number${index}` in variables; index++) {
    const number = variables[`number${index}`];
    const card =
      variables[`owner${index}`] === "getsentry" &&
      variables[`name${index}`] === "junior" &&
      typeof number === "number"
        ? cardOf(number)
        : undefined;
    if (card) known = true;
    data[`p${index}`] = card ? { pullRequest: card } : null;
  }
  return known ? Response.json({ data }) : undefined;
}

/** Count check runs by state, as `checkRunCountsByState` does. */
export function checkRunCounts(states: string[]) {
  const counts = new Map<string, number>();
  for (const state of states) counts.set(state, (counts.get(state) ?? 0) + 1);
  return {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              checkRunCountsByState: [...counts].map(([state, count]) => ({
                count,
                state,
              })),
            },
          },
        },
      },
    ],
  };
}
