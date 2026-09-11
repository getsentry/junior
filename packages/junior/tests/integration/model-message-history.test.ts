import { describe, expect, it } from "vitest";
import { createAgent } from "../fixtures/agent";

describe("model message history", () => {
  it("keeps earlier model messages unchanged", async () => {
    const agent = await createAgent();

    await agent.run("first request");
    const first = agent.snapshot();

    await agent.run("second request");
    const second = agent.snapshot();

    expect(second.slice(0, first.length)).toEqual(first);
  });
});
