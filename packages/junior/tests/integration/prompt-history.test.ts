import { afterEach, describe, expect, it } from "vitest";
import { closeConversationFixture } from "../fixtures/conversation";
import { createAgent } from "../fixtures/agent";

describe("prompt history", () => {
  afterEach(async () => {
    await closeConversationFixture();
  });

  it("keeps each model request as an exact prefix of the next", async () => {
    const agent = await createAgent();

    await agent.run("first request");
    const first = agent.snapshot();

    await agent.run("second request");
    const second = agent.snapshot();

    expect(second.slice(0, first.length)).toEqual(first);
  });
});
