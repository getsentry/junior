import type { SubscribedDecisionInput } from "@/chat/services/subscribed-decision";

/** Build a subscribed-thread routing input with stable defaults. */
export function makeSubscribedInput(
  overrides: Partial<SubscribedDecisionInput> = {},
): SubscribedDecisionInput {
  return {
    rawText: "hello",
    text: "hello",
    hasAttachments: false,
    isExplicitMention: false,
    context: {},
    ...overrides,
  };
}
