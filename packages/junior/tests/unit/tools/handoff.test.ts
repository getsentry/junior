import { describe, expect, it, vi } from "vitest";
import { createHandoffTool } from "@/chat/tools/handoff/tool";

describe("handoff", () => {
  it("describes the available profiles and limits the profile input", () => {
    const handoff = createHandoffTool({
      activeProfile: {
        name: "standard",
        description: "Use for routine lookups.",
      },
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

    for (const profile of [
      '"standard": Use for routine lookups.',
      '"coding": Use for implementation and debugging.',
      '"research": Use for research across several systems.',
    ]) {
      expect(handoff.description).toContain(profile);
    }
    expect(handoff.inputSchema).toMatchObject({
      properties: {
        profile: { enum: ["coding", "research"] },
      },
    });
  });
});
