import { describe, expect, it } from "vitest";
import {
  getAgentInvocationId,
  getAgentInvocationMessageId,
  getAgentInvocationResultMessageId,
  getAgentReplyMessageId,
  isAgentInvocationMessageId,
} from "@/chat/agent-invocations/ids";

describe("isAgentInvocationMessageId", () => {
  it("matches only the ids of parent messages", () => {
    const invocationId = getAgentInvocationId("parent", "turn:call-1");

    expect(
      isAgentInvocationMessageId(getAgentInvocationMessageId(invocationId)),
    ).toBe(true);
    expect(
      isAgentInvocationMessageId(
        getAgentInvocationResultMessageId(invocationId),
      ),
    ).toBe(false);
    expect(
      isAgentInvocationMessageId(getAgentReplyMessageId("child", "call-2")),
    ).toBe(false);
    expect(isAgentInvocationMessageId("slack:C123:1712345.0002")).toBe(false);
  });
});
