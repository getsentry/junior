import { expect, it } from "vitest";
import { interceptTestHttp } from "@sentry/junior-testing/http";
import { createWebFetchTool } from "@/chat/tools/web/fetch-tool";

it("serves the same failed PR through host and Sandbox inspection", async () => {
  const api = "https://api.github.com/repos/getsentry/junior";
  const pr = await fetch(`${api}/pulls/691`).then((response) =>
    response.json(),
  );
  expect(pr).toMatchObject({ number: 691, state: "open", merged: false });

  const checksUrl = new URL(`${api}/commits/${pr.head.sha}/check-runs`);
  const checks = await interceptTestHttp({
    provider: "github",
    request: new Request(checksUrl),
    upstreamUrl: checksUrl,
  }).then((response) => response.json());
  expect(checks.check_runs).toMatchObject([
    { id: 1, name: "test", head_sha: pr.head.sha, conclusion: "failure" },
  ]);

  // gh uses $repo for the repository name, not $name.
  const graphql = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      query: `query PullRequest($owner: String!, $repo: String!, $number: Int!) {
        repository(owner: $owner, name: $repo) {
          pullRequest(number: $number) {
            state headRefOid
            commits(last: 1) {
              nodes { commit { statusCheckRollup { contexts(first: 100) {
                nodes { ... on CheckRun { name conclusion } }
              } } } }
            }
          }
        }
      }`,
      variables: { owner: "getsentry", repo: "junior", number: 691 },
    }),
  });
  expect(graphql.status).toBe(200);
  const graphqlPr = (await graphql.json()).data.repository.pullRequest;
  expect(graphqlPr).toMatchObject({ state: "OPEN", headRefOid: pr.head.sha });
  expect(
    graphqlPr.commits.nodes[0].commit.statusCheckRollup.contexts.nodes,
  ).toMatchObject([{ name: "test", conclusion: "FAILURE" }]);

  const run = await fetch(`${api}/actions/runs/1`).then((response) =>
    response.json(),
  );
  expect(run).toMatchObject({
    head_sha: pr.head.sha,
    conclusion: "failure",
    check_suite_id: 42,
  });
  const page = await createWebFetchTool({}).execute!(
    { url: run.html_url },
    { experimental_context: undefined },
  );
  expect(page["content"]).toContain("State: open, not merged");
  expect(page["content"]).toContain(pr.head.sha);
  expect(page["content"]).toContain(checks.check_runs[0].output.summary);
  const logs = await fetch(`${api}/actions/jobs/1/logs`).then((response) =>
    response.text(),
  );
  expect(logs).toContain(checks.check_runs[0].output.summary);

  // Unspecified paths fail at the fixture edge; they cannot reach live GitHub.
  const unknown = new URL(`${api}/actions/runs/999`);
  expect(
    (
      await interceptTestHttp({
        provider: "github",
        request: new Request(unknown),
        upstreamUrl: unknown,
      })
    ).status,
  ).toBe(501);
});

it("serves the merged Craft release blocker with open alerts that only a person can dismiss", async () => {
  const api = "https://api.github.com/repos/getsentry/craft";
  const serve = (path: string) =>
    interceptTestHttp({
      provider: "github",
      request: new Request(`${api}${path}`),
      upstreamUrl: new URL(`${api}${path}`),
    }).then((response) => response.json());
  expect(await serve("/pulls/983")).toMatchObject({
    number: 983,
    merged: true,
  });
  // Plugin tools and `webFetch` read it in process.
  expect(
    await fetch(`${api}/pulls/983`).then((response) => response.json()),
  ).toMatchObject({ number: 983, merged: true });
  const page = await createWebFetchTool({}).execute!(
    { url: "https://github.com/getsentry/craft/pull/983" },
    { experimental_context: undefined },
  );
  expect(page["content"]).toContain("State: merged");
  expect(await serve("/dependabot/alerts")).toMatchObject([
    {
      number: 1,
      state: "open",
      dependency: { package: { name: "picomatch" } },
    },
    { number: 2, state: "open" },
  ]);
  const dismiss = await interceptTestHttp({
    provider: "github",
    request: new Request(`${api}/dependabot/alerts/1`, {
      body: JSON.stringify({ state: "dismissed" }),
      method: "PATCH",
    }),
    upstreamUrl: new URL(`${api}/dependabot/alerts/1`),
  });
  expect(dismiss.status).toBe(403);
});

it("answers the pull request tool's GraphQL read of the Craft release blocker", async () => {
  const graphql = "https://api.github.com/graphql";
  const response = await interceptTestHttp({
    provider: "github",
    request: new Request(graphql, {
      body: JSON.stringify({
        query:
          "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){mergeStateStatus}}}",
        variables: { name: "craft", number: 983, owner: "getsentry" },
      }),
      method: "POST",
    }),
    upstreamUrl: new URL(graphql),
  }).then((res) => res.json());
  expect(response.data.repository.pullRequest).toMatchObject({
    commits: { nodes: [expect.anything()] },
    mergeStateStatus: expect.any(String),
    reviewDecision: "APPROVED",
    state: "MERGED",
  });
});
