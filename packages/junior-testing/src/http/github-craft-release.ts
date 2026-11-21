// The last blocker of a Craft release, merged. Its Dependabot alerts list is
// empty: dismissing the alerts is the person's task in the eval.
const repo = "getsentry/craft";
const sha = "9830000000000000000000000000000000000983";
const web = `https://github.com/${repo}`;
const api = `/repos/${repo}`;
const mergedAt = "2026-01-02T00:00:00Z";
const pullRequest = {
  number: 983,
  title: "Patch picomatch",
  state: "closed",
  draft: false,
  merged: true,
  merged_at: mergedAt,
  closed_at: mergedAt,
  html_url: `${web}/pull/983`,
  user: { login: "junior-eval[bot]", type: "Bot" },
  head: { ref: "fix/picomatch-patch", sha },
  base: { ref: "master" },
};

function isPullRequestQuery(body: {
  query?: string;
  variables?: { number?: number; owner?: string; name?: string; repo?: string };
}): boolean {
  const query = body.query ?? "";
  return (
    !/\bmutation\b/.test(query) &&
    /\bpullRequest\s*\(/.test(query) &&
    (body.variables?.owner === "getsentry" ||
      /owner:\s*"getsentry"/.test(query)) &&
    (body.variables?.name === "craft" ||
      body.variables?.repo === "craft" ||
      /name:\s*"craft"/.test(query)) &&
    (body.variables?.number === 983 || /number:\s*983\b/.test(query))
  );
}

/** Serve the merged Craft release blocker without reading live GitHub. */
export async function interceptTestGitHubCraftReleaseHttp(
  request: Request,
  url: URL,
): Promise<Response | undefined> {
  if (url.hostname === "github.com" && request.method === "GET") {
    if (url.pathname !== `/${repo}/pull/983`) return undefined;
    return new Response(
      `Pull request #983: ${pullRequest.title}\nState: merged\nHead: ${sha}\n`,
      { headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  if (url.hostname !== "api.github.com") return undefined;
  if (request.method === "POST" && url.pathname === "/graphql") {
    if (!isPullRequestQuery(await request.clone().json())) return undefined;
    return Response.json({
      data: {
        repository: {
          pullRequest: {
            ...pullRequest,
            state: "MERGED",
            url: pullRequest.html_url,
            isDraft: false,
            mergedAt,
            autoMergeRequest: null,
            headRefName: pullRequest.head.ref,
            headRefOid: sha,
            baseRefName: pullRequest.base.ref,
          },
        },
      },
    });
  }
  if (request.method !== "GET") return undefined;
  switch (url.pathname) {
    case `${api}/issues/983`:
    case `${api}/pulls/983`:
      return Response.json(pullRequest);
    case `${api}/pulls/983/commits`:
      return Response.json([
        {
          sha,
          author: pullRequest.user,
          commit: { message: pullRequest.title },
        },
      ]);
    case `${api}/dependabot/alerts`:
      return Response.json([]);
    default:
      return undefined;
  }
}
