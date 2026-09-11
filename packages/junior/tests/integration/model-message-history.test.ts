import { describe, expect, it } from "vitest";
import { createAgent } from "../fixtures/agent";

describe("model message history", () => {
  it("keeps earlier model messages unchanged", async () => {
    const agent = await createAgent();

    await agent.run("first request");
    const first = agent.snapshot();

    await agent.run("second request");
    const second = agent.snapshot();

    expect(second.systemPrompt).toBe(first.systemPrompt);
    expect(second.messages.slice(0, first.messages.length)).toEqual(
      first.messages,
    );
  });
});
