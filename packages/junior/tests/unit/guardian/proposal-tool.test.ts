import { describe, expect, it } from "vitest";
import { describedProposal } from "@/chat/guardian/proposal-tool";
import type { AnyToolDefinition } from "@/chat/tool-support/definition";

const plain = { description: "A tool.", inputSchema: {} } as AnyToolDefinition;
const described = {
  ...plain,
  describeProposal: (input: unknown) => `Clone ${JSON.stringify(input)}.`,
} as AnyToolDefinition;

describe("describedProposal", () => {
  it("gives the current Guardian the summary, else the tool's own line", () => {
    expect(
      describedProposal(
        {
          summary: "Unpublish image abc.png.",
          target: { ref: "abc.png", audience: "world" },
        },
        described,
        {},
      ),
    ).toBe("Unpublish image abc.png.");
    expect(
      describedProposal(
        { target: { ref: "getsentry/junior#12", audience: "world" } },
        described,
        { repo: "getsentry/junior" },
      ),
    ).toBe('Clone {"repo":"getsentry/junior"}.');
    expect(
      describedProposal(
        {
          target: { ref: "getsentry/junior#12", audience: "world" },
          toolDecision: { decision: "allow", reason: "own-pr-text" },
        },
        plain,
        {},
      ),
    ).toBeUndefined();
  });
});
