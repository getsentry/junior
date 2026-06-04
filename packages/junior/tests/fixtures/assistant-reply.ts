import type { AssistantReply } from "@/chat/respond";

type AssistantReplyOverrides = Partial<
  Omit<AssistantReply, "diagnostics" | "text">
> & {
  diagnostics?: Partial<AssistantReply["diagnostics"]>;
};

/** Build a fully shaped successful assistant reply for deterministic runtime tests. */
export function successfulAssistantReply(
  text: string,
  overrides: AssistantReplyOverrides = {},
): AssistantReply {
  const { diagnostics, ...replyOverrides } = overrides;
  return {
    text,
    ...replyOverrides,
    diagnostics: {
      assistantMessageCount: 1,
      modelId: "fake-agent-model",
      outcome: "success",
      toolCalls: [],
      toolErrorCount: 0,
      toolResultCount: 0,
      usedPrimaryText: true,
      ...diagnostics,
    },
  };
}
