import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGitHubUpdateIssueTool } from "../src/tools/update-issue";
import { castThroughUnknown } from "@sentry/junior-plugin-api";

const ORIGINAL_WEBHOOK_SECRET = process.env.GITHUB_WEBHOOK_SECRET;

function toolContext(response?: Response) {
  const fetch = vi.fn(
    async () =>
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
      ),
  );
  const ctx = castThroughUnknown<ToolRegistrationHookContext>({
    actor: {
      platform: "slack",
      fullName: "David Cramer",
      userId: "U039RR91S",
      userName: "david",
    },
    conversationId: "slack:C123:123.456",
    egress: { fetch },
    resourceEvents: { canSubscribe: true },
    slack: {
      conversationLink: { url: "https://example.com/session" },
    },
    users: {
      resolveActor: async () => undefined,
    },
  });
  return { fetch, tool: createGitHubUpdateIssueTool(ctx) };
}

describe("updateIssue", () => {
  afterEach(() => {
    if (ORIGINAL_WEBHOOK_SECRET === undefined) {
      delete process.env.GITHUB_WEBHOOK_SECRET;
    } else {
      process.env.GITHUB_WEBHOOK_SECRET = ORIGINAL_WEBHOOK_SECRET;
    }
  });

  it("updates issue metadata and preserves Junior-owned body metadata", async () => {
    process.env.GITHUB_WEBHOOK_SECRET = "test-secret";
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
      subscribable: {
        identifier: "getsentry/junior#691",
      },
      url: "https://github.com/getsentry/junior/issues/691",
    });

    const call = fetch.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      operation: "github.issue.update",
      provider: "github",
    });
    expect(call?.request.method).toBe("PATCH");
    expect(call?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/issues/691",
    );
    const body = (await call?.request.clone().json()) as { body: string };
    expect(body.body).toContain("Requested by **David Cramer**.");
    expect(body.body).toContain(
      "[View Junior Session](https://example.com/session)",
    );
  });

  it.each([
    { repo: "getsentry/junior", number: 691 },
    { repo: "getsentry/junior", number: 691, title: "   " },
  ])("rejects invalid updates before calling GitHub", async (input) => {
    const { fetch, tool } = toolContext();

    await expect(
      tool.execute?.(input, { toolCallId: "update-issue" }),
    ).rejects.toThrow("Invalid GitHub updateIssue input.");
    expect(fetch).not.toHaveBeenCalled();
  });
});
