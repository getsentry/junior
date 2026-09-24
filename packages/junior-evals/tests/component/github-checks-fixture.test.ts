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
  expect(page.content).toContain("State: open, not merged");
  expect(page.content).toContain(pr.head.sha);
  expect(page.content).toContain(checks.check_runs[0].output.summary);
  const logs = await fetch(`${api}/actions/jobs/1/logs`).then((response) =>
    response.text(),
  );
  expect(logs).toContain(checks.check_runs[0].output.summary);

  // Unspecified paths fail at the fixture edge; they cannot reach live GitHub.
  const unknown = new URL(`${api}/actions/runs/999`);
  expect((await fetch(unknown)).status).toBe(501);
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
