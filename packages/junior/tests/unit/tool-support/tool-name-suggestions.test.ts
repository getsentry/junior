import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";
import { planToolExposure } from "@/chat/tool-exposure";
import { suggestToolNames } from "@/chat/tool-support/tool-name-suggestions";
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
  archiveAgent: demo({ source: "agents" }),
  github_createPullRequest: demo({ source: "github" }),
  listWatches: demo(),
  operatorSql: demo({ exposure: "hidden" }),
  searchAgents: demo({ source: "agents" }),
  stopAgent: demo({ source: "agents" }),
  stopWatchingResources: demo(),
});

describe("suggestToolNames", () => {
  it.each([
    ["agents.stopAgent", ["stopAgent"]],
    ["github.createPullRequest", ["github_createPullRequest"]],
    ["createPullRequest", ["github_createPullRequest"]],
    ["STOP_AGENT", ["stopAgent"]],
    ["stop-agent", ["stopAgent"]],
    ["stopAgnet", ["stopAgent"]],
    ["serachAgents", ["searchAgents"]],
  ])("suggests %s as %j", (name, expected) => {
    expect(suggestToolNames(name, catalogTools)).toEqual(expected);
  });

  it("suggests nothing for an unrelated name", () => {
    expect(suggestToolNames("sendEmail", catalogTools)).toEqual([]);
  });

  it("never suggests a tool that the caller cannot call", () => {
    expect(suggestToolNames("operatorSql", catalogTools)).toEqual([]);
  });

  it("returns at most three names, closest first, ties by name", () => {
    expect(
      suggestToolNames("tool", {
        toal: demo(),
        tol: demo(),
        tool1: demo(),
        tools: demo(),
        tools2: demo(),
      }),
    ).toEqual(["toal", "tol", "tool1"]);
  });
});
