// The watch event and every read of its PR must describe the same failed run.
const repo = "getsentry/junior";
const sha = "abcdef1234567890abcdef1234567890abcdef12";
const web = `https://github.com/${repo}`;
const api = `/repos/${repo}`;
const failure =
  "tests/cache.test.ts: expected a refreshed value, received a stale value";
const check = {
  id: 1,
  name: "test",
  head_sha: sha,
  status: "completed",
  conclusion: "failure",
  html_url: `${web}/actions/runs/1/job/1`,
  details_url: `${web}/actions/runs/1`,
  check_suite: { id: 42 },
  output: { title: "Cache refresh test failed", summary: failure },
};
const pullRequest = {
  id: 30_691,
  number: 691,
  title: "Refresh cached values after expiry",
  state: "open",
  draft: false,
  merged: false,
  html_url: `${web}/pull/691`,
  // The eval bot opened it. Its id comes from the eval `GITHUB_APP_BOT_EMAIL`,
  // and feedback tools work only on pull requests that the bot authored.
  user: { id: 12_345, login: "junior-eval[bot]", type: "Bot" },
  head: { ref: "fix/cache-refresh", sha },
  base: { ref: "main" },
};
const run = {
  id: 1,
  name: "test",
  workflow_id: 1,
  run_number: 1,
  run_attempt: 1,
  event: "pull_request",
  status: "completed",
  conclusion: "failure",
  head_branch: pullRequest.head.ref,
  head_sha: sha,
  html_url: `${web}/actions/runs/1`,
  check_suite_id: 42,
  pull_requests: [pullRequest],
};
// The reviews that the review Watch evals send for this PR, by id, with the
// login that wrote each one.
const reviewers = new Map([
  [9_002, "octo-reviewer"],
  [9_003, "octo-requester"],
  [9_004, "octo-requester"],
  [9_005, "octo-requester"],
]);
const job = {
  ...check,
  run_id: 1,
  steps: [
    {
      number: 1,
      name: "Run tests",
      status: "completed",
      conclusion: "failure",
    },
  ],
};

/** Serve the watch scenario's PR, checks, and logs without reading live GitHub. */
export async function interceptTestGitHubChecksHttp(
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (url.hostname === "github.com" && request.method === "GET") {
    if (
      [
        `/${repo}/pull/691`,
        `/${repo}/actions/runs/1`,
        `/${repo}/actions/runs/1/job/1`,
        `/${repo}/commit/${sha}/checks`,
      ].includes(url.pathname)
    ) {
      return new Response(
        `Pull request #691: ${pullRequest.title}\nState: open, not merged\nHead: ${sha}\nWorkflow: test\nConclusion: failure\n${failure}\n`,
        { headers: { "content-type": "text/plain; charset=utf-8" } },
      );
    }
    return undefined;
  }
  if (url.hostname !== "api.github.com") return undefined;
  if (request.method === "POST" && url.pathname === "/graphql") {
    const body = (await request.clone().json()) as {
      operationName?: string;
      query?: string;
      variables?: {
        content?: string;
        number?: number;
        owner?: string;
        name?: string;
        repo?: string;
        subjectId?: string;
      };
    };
    const query = body.query ?? "";
    // A review body has no REST reactions endpoint, so its reactions go
    // through GraphQL on the review's node id.
    const reviewNodeId = /^PRR_eval(\d+)$/.exec(
      body.variables?.subjectId ?? "",
    )?.[1];
    if (reviewNodeId && reviewers.has(Number(reviewNodeId))) {
      const reaction = { reaction: { content: body.variables?.content } };
      switch (body.operationName) {
        case "ReviewReactions":
          return Response.json({ data: { node: { reactionGroups: [] } } });
        case "AddReviewReaction":
          return Response.json({ data: { addReaction: reaction } });
        case "RemoveReviewReaction":
          return Response.json({ data: { removeReaction: reaction } });
        default:
          return undefined;
      }
    }
    if (
      !/\bmutation\b/.test(query) &&
      /\bpullRequest\s*\(/.test(query) &&
      (body.variables?.owner === "getsentry" ||
        /owner:\s*"getsentry"/.test(query)) &&
      (body.variables?.name === "junior" ||
        body.variables?.repo === "junior" ||
        /name:\s*"junior"/.test(query)) &&
      (body.variables?.number === 691 || /number:\s*691\b/.test(query))
    ) {
      return Response.json({
        data: {
          repository: {
            pullRequest: {
              ...pullRequest,
              state: "OPEN",
              url: pullRequest.html_url,
              isDraft: false,
              autoMergeRequest: null,
              mergeStateStatus: "BLOCKED",
              reviewDecision: "REVIEW_REQUIRED",
              headRefName: pullRequest.head.ref,
              headRefOid: sha,
              baseRefName: "main",
              commits: {
                nodes: [
                  {
                    commit: {
                      oid: sha,
                      statusCheckRollup: {
                        contexts: {
                          nodes: [
                            {
                              __typename: "CheckRun",
                              name: check.name,
                              status: "COMPLETED",
                              conclusion: "FAILURE",
                              detailsUrl: check.details_url,
                              isRequired: true,
                              checkSuite: {
                                workflowRun: { workflow: { name: "test" } },
                              },
                            },
                          ],
                          pageInfo: { hasNextPage: false },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      });
    }
    return undefined;
  }
  // Nobody has a pending review request, so Junior can ask the requester.
  if (url.pathname === `${api}/pulls/691/requested_reviewers`) {
    if (request.method === "GET") {
      return Response.json({ users: [], teams: [] });
    }
    if (request.method === "POST") {
      return Response.json(pullRequest, { status: 201 });
    }
  }
  // A review Watch marks each PR conversation comment as being reviewed.
  const commentId = url.pathname.match(
    new RegExp(`^${api}/issues/comments/(\\d+)/reactions$`),
  )?.[1];
  if (commentId && request.method === "POST") {
    const { content } = (await request.clone().json()) as { content?: string };
    return Response.json(
      { id: Number(commentId), content, user: pullRequest.user },
      { status: 201 },
    );
  }
  if (request.method !== "GET") return undefined;
  const reviewId = url.pathname.match(
    new RegExp(`^${api}/pulls/691/reviews/(\\d+)$`),
  )?.[1];
  if (reviewId) {
    const login = reviewers.get(Number(reviewId));
    return login
      ? Response.json({
          id: Number(reviewId),
          node_id: `PRR_eval${reviewId}`,
          user: { login, type: "User" },
        })
      : Response.json({ message: "Not Found" }, { status: 404 });
  }
  // The PR has reviews but no inline review comments, so GitHub finds no
  // review comment for a review id.
  if (url.pathname.startsWith(`${api}/pulls/comments/`)) {
    return Response.json({ message: "Not Found" }, { status: 404 });
  }
  // oxlint-disable-next-line junior/no-value-switch -- A fake server routes by URL path, not by type.
  switch (url.pathname) {
    // GitHub's issue endpoint also returns pull requests. Title generation
    // reads a plain owner/repo#number reference through this endpoint.
    case `${api}/issues/691`:
    case `${api}/pulls/691`:
      return Response.json(pullRequest);
    case `${api}/pulls/691/commits`:
      return Response.json([
        {
          sha,
          author: pullRequest.user,
          commit: { message: pullRequest.title },
        },
      ]);
    case `${api}/commits/${sha}`:
      return Response.json({ sha, commit: { message: pullRequest.title } });
    case `${api}/commits/${sha}/check-runs`:
    case `${api}/check-suites/42/check-runs`:
      return Response.json({ total_count: 1, check_runs: [check] });
    case `${api}/check-runs/1`:
      return Response.json(check);
    case `${api}/check-suites/42`:
      return Response.json({
        id: 42,
        head_sha: sha,
        conclusion: "failure",
        status: "completed",
      });
    case `${api}/actions/runs/1`:
      return Response.json(run);
    case `${api}/actions/runs`:
      return Response.json({ total_count: 1, workflow_runs: [run] });
    case `${api}/actions/runs/1/jobs`:
    case `${api}/actions/runs/1/attempts/1/jobs`:
      return Response.json({ total_count: 1, jobs: [job] });
    case `${api}/actions/jobs/1`:
      return Response.json(job);
    case `${api}/actions/jobs/1/logs`:
      return new Response(
        `Run tests\nFAIL ${failure}\nProcess completed with exit code 1.\n`,
        {
          headers: { "content-type": "text/plain; charset=utf-8" },
        },
      );
    default:
      return undefined;
  }
}
