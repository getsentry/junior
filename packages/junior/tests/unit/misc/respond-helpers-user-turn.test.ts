import { describe, expect, it } from "vitest";
import { buildUserTurnText } from "@/chat/respond-helpers";

describe("buildUserTurnText", () => {
  it("returns raw input when no context or metadata is provided", () => {
    expect(buildUserTurnText("hello")).toBe("hello");
  });
});
