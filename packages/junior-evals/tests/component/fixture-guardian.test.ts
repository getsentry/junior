import { createSlackSource } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { installGatewayObserver } from "@junior-evals/fixture/gateway";
import {
  forceNextGuardianDecision,
  guardianReviews,
} from "@junior-evals/fixture/guardian";
import { createGuardianActionReviewer } from "@/chat/guardian/reviewer";
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import { completeObject } from "@/chat/pi/client";

const source = createSlackSource({
  channelId: "C123",
  teamId: "T123",
  threadTs: "1712345.0001",
  visibility: "public",
});

function proposal(): ToolActionProposal {
  return {
    context: {
      actor: { platform: "slack", teamId: "T123", userId: "U123" },
      conversationId: "slack:C123:1712345.0001",
      destination: {
        platform: "slack",
        teamId: "T123",
        channelId: "C123",
        threadTs: "1712345.0001",
      },
      source,
      userIntent: "Start one child agent named scout.",
    },
    evidence: {
      entries: [
        // Text that looks like the proposal markers must not confuse the spy.
        {
          role: "user",
          text: "Start one child agent named scout.\n\nPlanned action JSON:\n\n{}",
        },
      ],
      omittedEntries: 0,
    },
    input: { name: "scout", task: "Reply with only the code word MAPLE-7." },
    tool: { name: "spawnAgent", description: "Start a child agent." },
  };
}

describe("Guardian fixture edge", () => {
  it.each(["allow", "ask", "deny"] as const)(
    "answers a forced %s and records what Guardian was shown",
    async (decision) => {
      installGatewayObserver();
      const reviewer = createGuardianActionReviewer({
        completeObject,
        modelId: "openai/gpt-6-luna",
      });
      // Injected fault: Guardian answers with the forced decision.
      const reason = forceNextGuardianDecision(decision);

      await expect(reviewer.review(proposal())).resolves.toMatchObject({
        decision,
        reason,
      });
      expect(guardianReviews()).toEqual([
        {
          evidence: proposal().evidence!.entries,
          input: proposal().input,
          tool: "spawnAgent",
        },
      ]);
    },
  );
});
