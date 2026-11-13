// Draft pull requests whose check suite just passed. Each draft has the same
// passing suite; they differ in other required checks and in the body.
// #695's checks are not required, like a suite that reports before the
// required checks start.
const repo = "getsentry/junior";
const web = `https://github.com/${repo}`;
const api = `/repos/${repo}`;

interface DraftFixture {
  body: string;
  failingCheck?: string;
  number: number;
  requiredNotReported?: true;
  sha: string;
}

const draftTitle = "Warm the cache on worker start";
const draftBody = "Warm the cache when the worker starts.";

const drafts: DraftFixture[] = [
  {
    body: draftBody,
    number: 692,
    sha: "6920000000000000000000000000000000000692",
  },
  {
    body: `${draftBody}\n\n## Open decision\n\nShould the warmup also run after each deploy? I need the requester to choose before this is ready.`,
    number: 693,
    sha: "6930000000000000000000000000000000000693",
  },
  {
    body: draftBody,
    failingCheck: "lint",
    number: 694,
    sha: "6940000000000000000000000000000000000694",
  },
  {
    body: draftBody,
    number: 695,
    requiredNotReported: true,
    sha: "6950000000000000000000000000000000000695",
  },
];

const readied = new Set<number>();

/** Reset the drafts that the scenario marked ready. */
export function resetTestGitHubDraftFixtures(): void {
  readied.clear();
}

function checkRuns(draft: DraftFixture) {
  return ["test", "lint"].map((name, index) => ({
    conclusion: name === draft.failingCheck ? "failure" : "success",
    details_url: `${web}/actions/runs/${draft.number}${index}`,
    html_url: `${web}/actions/runs/${draft.number}${index}/job/1`,
    id: draft.number * 10 + index,
    name,
    status: "completed",
  }));
}

function restPullRequest(draft: DraftFixture) {
  return {
    base: { ref: "main" },
    body: draft.body,
    draft: !readied.has(draft.number),
    head: { ref: `feat/cache-warmup-${draft.number}`, sha: draft.sha },
    html_url: `${web}/pull/${draft.number}`,
    merged: false,
    node_id: `PR_eval_${draft.number}`,
    number: draft.number,
    state: "open",
    title: draftTitle,
    user: { login: "junior-eval[bot]", type: "Bot" },
  };
}

// `github_getPullRequest` reads `commits(last: 1)`, and `gh pr view` aliases
// it as `statusCheckRollup`, so both fields carry the same commit.
function graphqlPullRequest(draft: DraftFixture) {
  const commits = {
    nodes: [
      {
        commit: {
          oid: draft.sha,
          statusCheckRollup: {
            contexts: {
              nodes: checkRuns(draft).map((check) => ({
                __typename: "CheckRun",
                checkSuite: {
                  workflowRun: {
                    event: "pull_request",
                    workflow: { name: "ci" },
                  },
                },
                completedAt: "2026-05-27T00:05:00Z",
                conclusion: check.conclusion.toUpperCase(),
                detailsUrl: check.details_url,
                isRequired: draft.requiredNotReported !== true,
                name: check.name,
                startedAt: "2026-05-27T00:00:00Z",
                status: "COMPLETED",
              })),
              pageInfo: { endCursor: null, hasNextPage: false },
            },
          },
        },
      },
    ],
  };
  return {
    baseRefName: "main",
    body: draft.body,
    commits,
    headRefName: `feat/cache-warmup-${draft.number}`,
    headRefOid: draft.sha,
    autoMergeRequest: null,
    id: `PR_eval_${draft.number}`,
    isDraft: !readied.has(draft.number),
    mergeStateStatus: readied.has(draft.number) ? "BLOCKED" : "DRAFT",
    number: draft.number,
    reviewDecision: null,
    state: "OPEN",
    statusCheckRollup: commits,
    title: draftTitle,
    url: `${web}/pull/${draft.number}`,
  };
}

function draftFromGraphql(body: {
  query?: string;
  variables?: Record<string, unknown>;
}): DraftFixture | undefined {
  const text = `${body.query ?? ""} ${JSON.stringify(body.variables ?? {})}`;
  return drafts.find(
    (draft) =>
      new RegExp(`PR_eval_${draft.number}\\b`).test(text) ||
      Object.values(body.variables ?? {}).includes(draft.number) ||
      new RegExp(`number:\\s*${draft.number}\\b`).test(text),
  );
}

/** Serve the draft scenario's pull requests, checks, and ready mutation. */
export async function interceptTestGitHubDraftsHttp(
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (url.hostname !== "api.github.com") return undefined;
  if (request.method === "POST" && url.pathname === "/graphql") {
    const body = (await request.clone().json()) as {
      query?: string;
      variables?: Record<string, unknown>;
    };
    const draft = draftFromGraphql(body);
    if (!draft) return undefined;
    if (/markPullRequestReadyForReview/.test(body.query ?? "")) {
      readied.add(draft.number);
      return Response.json({
        data: { result: { pullRequest: { isDraft: false } } },
      });
    }
    if (/\bmutation\b/.test(body.query ?? "")) return undefined;
    const pullRequest = graphqlPullRequest(draft);
    return Response.json({
      data: { node: pullRequest, repository: { pullRequest } },
    });
  }
  if (request.method !== "GET") return undefined;
  for (const draft of drafts) {
    switch (url.pathname) {
      case `${api}/pulls/${draft.number}`:
      case `${api}/issues/${draft.number}`:
        return Response.json(restPullRequest(draft));
      case `${api}/commits/${draft.sha}/check-runs`: {
        const runs = checkRuns(draft);
        return Response.json({ check_runs: runs, total_count: runs.length });
      }
    }
  }
  return undefined;
}
