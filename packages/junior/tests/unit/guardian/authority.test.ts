import { describe, expect, it } from "vitest";
import {
  actionHash,
  proposalActionHash,
  reviewWithAuthority,
} from "@/chat/guardian/authority";
import type { Guardian, GuardianRequest } from "@/chat/guardian/guardian";
import type { ToolActionProposal } from "@/chat/guardian/proposal";

function proposal(input: Record<string, unknown>): ToolActionProposal {
  return {
    context: {
      actor: { platform: "local", userId: "local-user" },
      conversationId: "local:guardian-test",
      destination: { platform: "local", conversationId: "local:guardian-test" },
      source: {
        kind: "local",
        visibility: "private",
        conversationId: "local:guardian-test",
      },
      userIntent: "Deploy the staging branch.",
    },
    input,
    tool: { description: "Run a command.", name: "bash" },
  };
}

/** A Guardian that asks about each action and records what it reviewed. */
function askingGuardian(reviewed: GuardianRequest[]): Guardian {
  return {
    onUnavailable: "fail-action",
    async review(request) {
      reviewed.push(request);
      return {
        actions: request.actions.map(() => ({
          decidedBy: "guardian" as const,
          decision: {
            decision: "ask" as const,
            reason: "Needs the person.",
            riskLevel: "medium" as const,
            userAuthorization: "low" as const,
          },
          outcome: "ask" as const,
        })),
        inboxItems: 1,
      };
    },
  };
}

describe("action hash", () => {
  it("ignores key order and changes with the input or credential subject", () => {
    const base = { tool: "bash", input: { a: 1, b: { c: 2, d: 3 } } };
    expect(actionHash(base)).toBe(
      actionHash({ tool: "bash", input: { b: { d: 3, c: 2 }, a: 1 } }),
    );
    expect(actionHash(base)).not.toBe(
      actionHash({ ...base, input: { a: 2, b: { c: 2, d: 3 } } }),
    );
    expect(actionHash(base)).not.toBe(
      actionHash({ ...base, credentialSubject: "U1" }),
    );
  });
});

describe("review with authority", () => {
  it("runs a confirmed action as the person's decision and reviews the rest", async () => {
    const confirmed = proposal({ command: "deploy staging" });
    const other = proposal({ command: "deploy production" });
    const reviewed: GuardianRequest[] = [];

    const result = await reviewWithAuthority(
      askingGuardian(reviewed),
      {
        actions: [confirmed, other],
        authority: {
          lines: [],
          confirmations: [
            { actionHash: proposalActionHash(confirmed), answerId: "answer_1" },
          ],
          created: [],
          grants: [],
        },
      },
      {},
    );

    expect(result.actions.map((action) => action.outcome)).toEqual([
      "allow",
      "ask",
    ]);
    expect(result.actions[0]).toMatchObject({ decidedBy: "person" });
    expect(reviewed.map((request) => request.actions)).toEqual([[other]]);
    expect(result.inboxItems).toBe(1);
  });

  it("does not call the Guardian when the person confirmed every action", async () => {
    const confirmed = proposal({ command: "deploy staging" });
    const reviewed: GuardianRequest[] = [];

    const result = await reviewWithAuthority(
      askingGuardian(reviewed),
      {
        actions: [confirmed],
        authority: {
          lines: [],
          confirmations: [
            { actionHash: proposalActionHash(confirmed), answerId: "answer_1" },
          ],
          created: [],
          grants: [],
        },
      },
      {},
    );

    expect(result).toMatchObject({ actions: [{ outcome: "allow" }] });
    expect(result.inboxItems).toBe(0);
    expect(reviewed).toEqual([]);
  });
});
