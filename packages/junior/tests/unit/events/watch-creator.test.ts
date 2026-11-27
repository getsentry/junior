import { describe, expect, it } from "vitest";
import { watchCreatorFor } from "@/chat/events/watch-creator";

const person = { platform: "slack", teamId: "T1", userId: "U1" } as const;

describe("watchCreatorFor", () => {
  it("names who a Watch that the Run sets serves", () => {
    expect(watchCreatorFor({ actor: person })).toEqual({ actor: person });
    expect(
      watchCreatorFor({
        actor: person,
        provenance: { authority: "instruction" },
      }),
    ).toEqual({});
    expect(
      watchCreatorFor({ actor: { platform: "system", name: "event" } }),
    ).toBeUndefined();
    expect(
      watchCreatorFor({
        actor: { platform: "system", name: "event" },
        watch: {
          creator: { actor: person, plugin: "github" },
          events: [{ instructions: "Maintain it." }],
        },
      }),
    ).toEqual({ actor: person });
  });
});
