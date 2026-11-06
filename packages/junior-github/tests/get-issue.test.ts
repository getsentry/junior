import { describe, expect, it, vi } from "vitest";
import { createGitHubGetIssueTool } from "../src/tools/get-issue";
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

function toolContext(
  response: { body?: unknown; status?: number } = issue(),
  user: typeof linkedUser | null = linkedUser,
) {
  const adapter = createGitHubApiTestAdapter([response]);
  const tool = createGitHubGetIssueTool({
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
