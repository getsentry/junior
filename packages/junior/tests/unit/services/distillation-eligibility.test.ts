import { describe, expect, it } from "vitest";
import { allowsDistillationForUsers } from "@/chat/distillation/eligibility";

describe("personal Conversation distillation", () => {
  it("allows only a linked user's authored history", () => {
    const allowed = ["user-one"];
    expect(allowsDistillationForUsers(allowed, "user-one", ["user-one"])).toBe(
      true,
    );
    expect(
      allowsDistillationForUsers(allowed, "user-one", ["user-one", "user-two"]),
    ).toBe(false);
    expect(
      allowsDistillationForUsers(allowed, "user-one", ["user-one", undefined]),
    ).toBe(false);
    expect(allowsDistillationForUsers(allowed, "user-two", ["user-one"])).toBe(
      false,
    );
    expect(allowsDistillationForUsers(allowed, undefined, ["user-one"])).toBe(
      false,
    );
    expect(allowsDistillationForUsers(allowed, "user-one", [])).toBe(false);
    expect(allowsDistillationForUsers([], "user-one", ["user-one"])).toBe(true);
    expect(allowsDistillationForUsers([], "user-one", ["user-two"])).toBe(
      false,
    );
    expect(allowsDistillationForUsers([], undefined, [undefined])).toBe(false);
  });
});
