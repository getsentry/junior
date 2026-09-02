import { describe, expect, it, vi } from "vitest";
import { createHandoffTool } from "@/chat/tools/handoff/tool";

describe("handoff", () => {
  it("describes the available profiles and limits the profile input", () => {
    const handoff = createHandoffTool({
      profiles: [
        {
          name: "coding",
          description: "Use for implementation and debugging.",
        },
        {
          name: "research",
          description: "Use for research across several systems.",
        },
      ],
      execute: vi.fn(),
    });

    expect(handoff.description).toMatchInlineSnapshot(`
      "Switch this conversation to another configured model profile and continue the same task. Call this as the only tool in the assistant turn, before substantial analysis or implementation, when a listed profile's description fits the task better than the current profile. Use each description's use and avoid cases. Do not select by the profile name or assume that a non-default profile is stronger. Do not call this for ordinary lookups, short answers, light investigation, or only because the task mentions code. Do not call this after you have done the difficult work on the current profile. Do not combine it with other tools in the same assistant message. A successful handoff becomes the active profile for later turns. Another handoff can change it again. Available profiles:
      - "coding": Use for implementation and debugging.
      - "research": Use for research across several systems."
    `);
    expect(handoff.inputSchema).toMatchObject({
      properties: {
        profile: { enum: ["coding", "research"] },
      },
    });
  });
});
