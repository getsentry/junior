import { describe, expect, it, vi } from "vitest";
import type { ToolRegistrationHookContext } from "@sentry/junior-plugin-api";
import { createLinearTools } from "../src/tools";

function issue() {
  return {
    id: "issue-id",
    identifier: "ENG-123",
    title: "Linear tools",
    description: null,
    priority: 3,
    url: "https://linear.app/acme/issue/ENG-123/linear-tools",
    state: { id: "state-id", name: "Todo" },
    team: { id: "team-id", key: "ENG", name: "Engineering" },
    project: null,
  };
}

function toolContext(data: unknown) {
  const requests: Array<{
    operation: string;
    provider: string;
    request: Request;
  }> = [];
  const upsert = vi.fn(async () => {});
  const ctx = {
    annotations: { upsert },
    egress: {
      fetch: async (input: {
        operation: string;
        provider: string;
        request: Request;
      }) => {
        requests.push(input);
        return Response.json({ data });
      },
    },
  };
  // @ts-expect-error test supplies the tool-owned context only
  const tools = createLinearTools(ctx as ToolRegistrationHookContext);
  return { requests, tools, upsert };
}

describe("Linear tools", () => {
  it("gets an issue without adding an authorization header", async () => {
    const { requests, tools } = toolContext({ issue: issue() });

    await expect(
      tools.getIssue?.execute?.({ id: "ENG-123" }, { toolCallId: "get" }),
    ).resolves.toEqual({ issue: issue() });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      operation: "linear.issue.get",
      provider: "linear",
    });
    expect(requests[0]?.request.headers.has("authorization")).toBe(false);
  });

  it("creates and annotates an issue", async () => {
    const { requests, tools, upsert } = toolContext({
      issueCreate: { success: true, issue: issue() },
    });

    await expect(
      tools.createIssue?.execute?.(
        { teamId: "team-id", title: "Linear tools" },
        { toolCallId: "create" },
      ),
    ).resolves.toEqual({ issue: issue() });

    expect(requests[0]).toMatchObject({
      operation: "linear.issue.create",
      provider: "linear",
    });
    expect(upsert).toHaveBeenCalledWith({
      kind: "resource_link",
      key: "ENG-123",
      label: "ENG-123",
      status: "open",
      url: issue().url,
    });
  });

  it("returns Linear errors to the caller", async () => {
    const { tools } = toolContext(undefined);
    const ctx = {
      egress: {
        fetch: async () =>
          Response.json({ errors: [{ message: "Issue not found" }] }),
      },
    };
    // @ts-expect-error test supplies the tool-owned context only
    const failingTools = createLinearTools(ctx as ToolRegistrationHookContext);

    await expect(
      failingTools.getIssue?.execute?.(
        { id: "ENG-404" },
        { toolCallId: "missing" },
      ),
    ).rejects.toMatchObject({
      message: "Issue not found",
      name: "PluginToolInputError",
    });
    expect(tools.getIssue).toBeDefined();
  });
});
