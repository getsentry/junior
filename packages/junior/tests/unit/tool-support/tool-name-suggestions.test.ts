import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { planToolExposure } from "@/chat/tool-exposure";
import {
  findToolNameHint,
  renderToolNameHint,
} from "@/chat/tool-support/tool-name-suggestions";
import { tool, type AnyToolDefinition } from "@/chat/tools/definition";

function demo(
  options: { exposure?: "hidden"; source?: string } = {},
): AnyToolDefinition {
  return tool({
    description: "Demo",
    inputSchema: Type.Object({}),
    ...(options.exposure ? { exposure: options.exposure } : undefined),
    ...(options.source
      ? { source: { id: options.source, description: options.source } }
      : undefined),
  });
}

const { catalogTools } = planToolExposure({
  agentBrowser_snapshot: demo({ source: "agent-browser" }),
  archiveAgent: demo({ source: "agents" }),
  github_createCanvas: demo({ source: "github" }),
  github_createPullRequest: demo({ source: "github" }),
  listWatches: demo(),
  operatorSql: demo({ exposure: "hidden", source: "agents" }),
  listAgents: demo({ source: "agents" }),
  slackCanvasCreate: demo({ source: "slack" }),
  spawnAgent: demo({ source: "agents" }),
  stopAgent: demo({ source: "agents" }),
  stopWatchingResources: demo(),
});

function hint(name: string, tools = catalogTools): string {
  return renderToolNameHint(findToolNameHint(name, tools));
}

describe("findToolNameHint", () => {
  it.each([
    // Exact match after normalization or a source id prefix.
    ["agents.stopAgent", "stopAgent"],
    ["github.createPullRequest", "github_createPullRequest"],
    ["createPullRequest", "github_createPullRequest"],
    ["STOP_AGENT", "stopAgent"],
    ["stop-agent", "stopAgent"],
    ["agent-browser.snapshot", "agentBrowser_snapshot"],
    // Words of the rest, within the source.
    ["agents.stop", "stopAgent"],
    ["agents_spawn", "spawnAgent"],
    ["slack.canvasCreate", "slackCanvasCreate"],
    ["agentBrowser_snap", "agentBrowser_snapshot"],
    // Edits within the source.
    ["github_createPullReqest", "github_createPullRequest"],
    ["agents.stopAgnet", "stopAgent"],
    // Edits on the full name.
    ["stopAgnet", "stopAgent"],
    ["lsitAgents", "listAgents"],
  ])("suggests %s as %s", (name, expected) => {
    expect(hint(name)).toBe(`Did you mean \`${expected}\`?`);
  });

  it("lists the source's tools when nothing in it matches", () => {
    expect(hint("agents.kill")).toBe(
      "Tools in `agents`: archiveAgent, listAgents, spawnAgent, stopAgent.",
    );
  });

  it("suggests nothing for an unrelated name", () => {
    expect(hint("sendEmail")).toBe("");
  });

  it("never suggests a tool from another source", () => {
    expect(hint("slack_createCanvas")).toBe(
      "Tools in `slack`: slackCanvasCreate.",
    );
    expect(
      hint("slack_createCanvas", {
        github_createCanvas: demo({ source: "github" }),
      }),
    ).toBe("");
  });

  it("never suggests a tool that the caller cannot call", () => {
    expect(hint("operatorSql")).toBe("");
  });

  it("returns at most three names, closest first, ties by name", () => {
    expect(
      hint("tool", {
        toal: demo(),
        tol: demo(),
        tool1: demo(),
        tools: demo(),
        tools2: demo(),
      }),
    ).toBe("Did you mean `toal`, `tol`, or `tool1`?");
  });
});
