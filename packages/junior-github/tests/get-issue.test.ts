import { bindPluginTool } from "@sentry/junior-testing/plugin-tool";
import { describe, expect, it, vi } from "vitest";
import { gitHubGetIssueTool } from "../src/tools/get-issue";
import { createGitHubApiTestAdapter } from "./github-api-adapter";

const linkedUser = {
  displayName: "David Cramer",
  id: "user-1",
  identities: [
    {
      id: "github-identity",
      provider: "github",
      providerSubjectId: "1473041",
      handle: "dcramer",
    },
  ],
};

function issue(input: { assignees?: string[]; state?: string } = {}) {
  return {
    body: {
      assignees: (input.assignees ?? []).map((login) => ({ login })),
      body: "Guardian drops the request.",
      comments: 3,
      html_url: "https://github.com/getsentry/junior/issues/2768",
      labels: [{ name: "bug" }],
      number: 2768,
      state: input.state ?? "open",
      title: "Guardian window",
      updated_at: "2026-11-05T19:00:00Z",
      user: { login: "dcramer" },
    },
  };
}

type QueuedResponse = Parameters<typeof createGitHubApiTestAdapter>[0][number];

function toolContext(
  response: QueuedResponse | QueuedResponse[] = issue(),
  user: typeof linkedUser | null = linkedUser,
) {
  const adapter = createGitHubApiTestAdapter(
    Array.isArray(response) ? response : [response],
  );
  const tool = bindPluginTool(gitHubGetIssueTool, {
    actor: {
      platform: "slack",
      fullName: "David Cramer",
      userId: "U039RR91S",
      userName: "david",
    },
    egress: adapter.egress,
    events: { canSubscribe: true },
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    users: { resolveActor: async () => (user ? { user } : undefined) },
  } as never);
  return { adapter, tool };
}

async function getIssue(tool: ReturnType<typeof toolContext>["tool"]) {
  return await tool.execute?.(
    { repo: "getsentry/junior", number: 2768 },
    { toolCallId: "get-issue" },
  );
}

describe("getIssue", () => {
  it("returns the issue and tells the agent to claim it when the requester is not assigned", async () => {
    const { adapter, tool } = toolContext();

    await expect(getIssue(tool)).resolves.toMatchObject({
      assignees: [],
      author: "dcramer",
      body: "Guardian drops the request.",
      comments: 3,
      labels: ["bug"],
      note: expect.stringContaining("assign_requester: true"),
      number: 2768,
      state: "open",
      subscribable: { identifier: "getsentry/junior#2768" },
      target: "getIssue",
    });
    expect(adapter.requests()).toEqual([
      expect.objectContaining({ operation: "github.issue.get" }),
    ]);
  });

  it.each([
    [
      "the requester is assigned",
      issue({ assignees: ["DCramer"] }),
      linkedUser,
    ],
    ["the issue is closed", issue({ state: "closed" }), linkedUser],
    ["the requester has no linked GitHub account", issue(), null],
  ])("omits the claim note when %s", async (_case, response, user) => {
    const { tool } = toolContext(response, user);

    expect(await getIssue(tool)).not.toHaveProperty("note");
  });

  it("follows the redirect of a transferred issue to its new repository", async () => {
    const moved = issue();
    const { adapter, tool } = toolContext([
      {
        headers: {
          location: "https://api.github.com/repositories/873328/issues/88085",
        },
        status: 301,
      },
      {
        body: {
          ...moved.body,
          html_url: "https://github.com/getsentry/sentry/issues/88085",
          number: 88085,
          repository_url: "https://api.github.com/repos/getsentry/sentry",
        },
      },
    ]);

    await expect(getIssue(tool)).resolves.toMatchObject({
      number: 88085,
      subscribable: { identifier: "getsentry/sentry#88085" },
      url: "https://github.com/getsentry/sentry/issues/88085",
    });
    expect(adapter.requests().map(({ request }) => request.url)).toEqual([
      "https://api.github.com/repos/getsentry/junior/issues/2768",
      "https://api.github.com/repositories/873328/issues/88085",
    ]);
  });

  it("does not follow a redirect off the GitHub API host", async () => {
    const { adapter, tool } = toolContext({
      headers: { location: "https://example.com/issues/1" },
      status: 301,
    });

    await expect(getIssue(tool)).rejects.toThrow(
      "GitHub issue lookup failed with HTTP 301",
    );
    expect(adapter.requests()).toHaveLength(1);
  });

  it("reports a missing issue as a repairable tool error", async () => {
    const { tool } = toolContext({
      body: { message: "Not Found" },
      status: 404,
    });

    await expect(getIssue(tool)).rejects.toMatchObject({
      message: "GitHub issue lookup failed with HTTP 404",
      name: "PluginToolInputError",
    });
  });
});
