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
      "Switch this conversation to another configured model profile and continue the same task. Call this as the only tool in the assistant message when a listed profile's description fits the task better than the current profile. Select the profile before substantial analysis or implementation. If initial discovery reveals work that fits another profile, switch before doing that work. Use each description's use and avoid cases. Do not select by the profile name or assume that a non-default profile is stronger. Do not switch merely because the task mentions code, uses tools, or a tool fails. Do not switch just to summarize work already completed. A successful handoff becomes the active profile for later turns. For a new request, return to a profile for routine work when its description fits, even if earlier work needed a different profile. Available profiles:
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
