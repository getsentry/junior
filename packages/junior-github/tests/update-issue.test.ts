import { describe, expect, it, vi } from "vitest";
import { createGitHubUpdateIssueTool } from "../src/tools/update-issue";

const linkedUser = {
  displayName: "David Cramer",
  email: "david@example.com",
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

function assignedIssue(assignees: string[]): Response {
  return new Response(
    JSON.stringify({
      assignees: assignees.map((login) => ({ login })),
      body: "Body",
      html_url: "https://github.com/getsentry/junior/issues/691",
      number: 691,
      state: "open",
      title: "Title",
    }),
    { status: 201 },
  );
}

function toolContext(
  response?: Response,
  user: typeof linkedUser | undefined = undefined,
) {
  const fetch = vi.fn(async (input: { operation: string }) => {
    // Updates read the body that is on GitHub before they write.
    if (input.operation === "github.issue.get") {
      return new Response(
        JSON.stringify({
          body: "Old body\n\n<!-- junior-request-attribution:start -->\nvia @lcian.\n<!-- junior-request-attribution:end -->",
        }),
        { status: 200 },
      );
    }
    return (
      response ??
      new Response(
        JSON.stringify({
          body: "Updated body",
          html_url: "https://github.com/getsentry/junior/issues/691",
          number: 691,
          state: "open",
          title: "Updated title",
        }),
        { status: 200 },
      )
    );
  });
  const ctx = {
    actor: {
      platform: "slack",
      fullName: "David Cramer",
      userId: "U039RR91S",
      userName: "david",
    },
    conversationId: "slack:C123:123.456",
    egress: { fetch },
    log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
    events: { canSubscribe: true },
    conversationLink: { url: "https://example.com/session" },
    users: {
      resolveActor: async () => (user ? { user } : undefined),
    },
  };
  return { fetch, tool: createGitHubUpdateIssueTool(ctx) };
}

describe("updateIssue", () => {
  it("updates issue metadata and preserves runtime-owned body metadata", async () => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          number: 691,
          title: "Updated title",
          body: "Updated body",
          state: "open",
        },
        { toolCallId: "update-issue" },
      ),
    ).resolves.toMatchObject({
      number: 691,
      state: "open",
      target: "updateIssue",
      title: "Updated title",
      objectAnnotations: [{ description: "Updated body" }],
      subscribable: {
        identifier: "getsentry/junior#691",
      },
      url: "https://github.com/getsentry/junior/issues/691",
    });

    expect(fetch.mock.calls[0]?.[0]).toMatchObject({
      operation: "github.issue.get",
    });
    const call = fetch.mock.calls[1]?.[0];
    expect(call).toMatchObject({
      operation: "github.issue.update",
      provider: "github",
    });
    expect(call?.request.method).toBe("PATCH");
    expect(call?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/issues/691",
    );
    const body = (await call?.request.clone().json()) as { body: string };
    // A new requester joins the requesters already on GitHub.
    expect(body.body).toContain("via @lcian, **David Cramer**.");
    expect(body.body).toContain("[View Session](https://example.com/session)");
  });

  it("assigns the requester and keeps the other assignees", async () => {
    const { fetch, tool } = toolContext(
      assignedIssue(["lcian", "dcramer"]),
      linkedUser,
    );

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 691, assign_requester: true },
        { toolCallId: "claim-issue" },
      ),
    ).resolves.toMatchObject({ assignees: ["lcian", "dcramer"], number: 691 });

    // Only the add endpoint is called. An issue PATCH would replace assignees.
    expect(fetch).toHaveBeenCalledTimes(1);
    const call = fetch.mock.calls[0]?.[0];
    expect(call).toMatchObject({ operation: "github.issue.assign" });
    expect(call?.request.method).toBe("POST");
    expect(call?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/issues/691/assignees",
    );
    await expect(call?.request.clone().json()).resolves.toEqual({
      assignees: ["dcramer"],
    });
  });

  it("fails before any write when the requester has no linked GitHub account", async () => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(
        {
          repo: "getsentry/junior",
          number: 691,
          state: "closed",
          assign_requester: true,
        },
        { toolCallId: "claim-issue" },
      ),
    ).rejects.toThrow("no linked GitHub account");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails when GitHub ignores the assignee", async () => {
    const { tool } = toolContext(assignedIssue([]), linkedUser);

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 691, assign_requester: true },
        { toolCallId: "claim-issue" },
      ),
    ).rejects.toThrow("GitHub did not assign @dcramer");
  });

  it.each([
    { repo: "getsentry/junior", number: 691 },
    { repo: "getsentry/junior", number: 691, title: "   " },
    { repo: "getsentry/junior", number: 691, assign_requester: false },
  ])("rejects invalid updates before calling GitHub", async (input) => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(input, { toolCallId: "update-issue" }),
    ).rejects.toThrow("Invalid GitHub updateIssue input.");
    expect(fetch).not.toHaveBeenCalled();
  });
});
