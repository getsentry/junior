/**
 * GitHub pull request payloads and a GraphQL stub for the pull request
 * cache tests: REST and webhook pull requests, check run counts, and card
 * and patch query answers.
 */
import { http, HttpResponse } from "msw";
import { mswServer } from "../msw/server";
import { GITHUB_REPO } from "./github-objects";

/** The time of the first pull request in these tests. */
export const T0 = "2026-01-02T03:00:00Z";

/** A REST or webhook pull request, with fields to override. */
export function pullRequest(
  number: number,
  overrides: Record<string, unknown> = {},
) {
  return {
    additions: 120,
    base: { ref: "main" },
    body: "Cache GitHub objects.",
    changed_files: 4,
    closed_at: null,
    created_at: "2026-01-01T00:00:00Z",
    deletions: 8,
    draft: false,
    head: { ref: "feat/object-cache", sha: "aaa111" },
    html_url: `${GITHUB_REPO}/pull/${number}`,
    id: number * 1000,
    mergeable: true,
    merged: false,
    merged_at: null,
    node_id: `PR_${number}`,
    number,
    state: "open",
    title: "Cache GitHub objects",
    updated_at: T0,
    user: { login: "byk" },
    ...overrides,
  };
}

/** A `commits` result with the check run counts of the head commit. */
export function checkRuns(counts: Record<string, number>) {
  return {
    nodes: [
      {
        commit: {
          statusCheckRollup: {
            contexts: {
              checkRunCountsByState: Object.entries(counts).map(
                ([state, count]) => ({ count, state }),
              ),
            },
          },
        },
      },
    ],
  };
}

/** Card and patch queries name pull requests by repository and number. */
export interface GraphqlQuery {
  numbers: number[];
  operationName: string;
}

/**
 * Answer GraphQL queries and keep them. Each alias of a query gets the pull
 * request of its number that the answer has. A card query answers from
 * `cards`, or with the HTTP status that `cards` returns for the numbers
 * that it asks for. A patch query answers from the next list of `patches`.
 */
export function stubGraphql(answers: {
  cards?: unknown[] | ((numbers: number[]) => unknown[] | number);
  patches?: unknown[][];
}): GraphqlQuery[] {
  const queries: GraphqlQuery[] = [];
  mswServer.use(
    http.post("https://api.github.com/graphql", async ({ request }) => {
      const { operationName, variables } = (await request.json()) as {
        operationName: string;
        variables: Record<string, unknown>;
      };
      const numbers = Object.entries(variables).flatMap(([name, value]) =>
        name.startsWith("number") ? [Number(value)] : [],
      );
      queries.push({ numbers, operationName });
      const cards =
        operationName === "PullRequestHeadFacts"
          ? (answers.patches?.shift() ?? [])
          : typeof answers.cards === "function"
            ? answers.cards(numbers)
            : (answers.cards ?? []);
      if (typeof cards === "number") {
        return HttpResponse.json(
          { message: "Server Error" },
          { status: cards },
        );
      }
      const byNumber = new Map(
        cards.map((node) => [(node as { number: number }).number, node]),
      );
      return HttpResponse.json({
        data: Object.fromEntries(
          numbers.map((number, index) => [
            `p${index}`,
            byNumber.has(number) ? { pullRequest: byNumber.get(number) } : null,
          ]),
        ),
      });
    }),
  );
  return queries;
}

/**
 * The merge state and check patch queries. A page read also asks for the
 * card of an entry with no review decision, such as a REST read.
 */
export function patchQueries(queries: GraphqlQuery[]): GraphqlQuery[] {
  return queries.filter(
    (query) => query.operationName === "PullRequestHeadFacts",
  );
}

/** A card query result for one open pull request. */
export function cardNode(number: number) {
  return {
    additions: number,
    author: { login: "junior-test[bot]" },
    baseRefName: "main",
    body: "Cache GitHub objects.",
    changedFiles: 2,
    commits: checkRuns({ SUCCESS: 2 }),
    deletions: 1,
    headRefName: `feat/${number}`,
    headRefOid: "ddd444",
    isDraft: number === 35,
    mergeable: "MERGEABLE",
    merged: false,
    number,
    reviewRequests: { nodes: [] },
    state: "OPEN",
    title: `Renamed ${number}`,
    updatedAt: "2026-01-02T06:00:00Z",
    url: `${GITHUB_REPO}/pull/${number}`,
  };
}
