import { describe, expect, it, vi } from "vitest";
import { createGitHubReactToIssueTool } from "../src/tools/react-to-issue";

function toolContext(response: Response) {
  const fetch = vi.fn(async () => response);
  return { fetch, tool: createGitHubReactToIssueTool({ fetch }) };
}

describe("reactToIssue", () => {
  it("adds a reaction to the issue itself", async () => {
    const { fetch, tool } = toolContext(
      new Response(JSON.stringify({ id: 7, content: "eyes" }), { status: 201 }),
    );

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 3037, content: "eyes" },
        { toolCallId: "react" },
      ),
    ).resolves.toEqual({
      target: "reactToIssue",
      repo: "getsentry/junior",
      number: 3037,
      content: "eyes",
      reaction_id: 7,
    });

    const call = fetch.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      operation: "github.issue.reaction.create",
      provider: "github",
    });
    expect(call?.request.method).toBe("POST");
    expect(call?.request.url).toBe(
      "https://api.github.com/repos/getsentry/junior/issues/3037/reactions",
    );
    await expect(call?.request.clone().json()).resolves.toEqual({
      content: "eyes",
    });
  });

  it("returns GitHub validation errors to the agent", async () => {
    const { tool } = toolContext(
      new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }),
    );

    await expect(
      tool.execute?.(
        { repo: "getsentry/junior", number: 3037, content: "eyes" },
        { toolCallId: "missing" },
      ),
    ).rejects.toThrow("GitHub issue reaction failed with HTTP 404: Not Found");
  });
});
