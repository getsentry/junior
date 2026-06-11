import { describe, expect, it } from "vitest";
import { normalizeLocalConversationId } from "@/chat/local/conversation";

describe("local conversation ids", () => {
  it("normalizes generated run slugs into local conversation ids scoped by cwd", () => {
    expect(
      normalizeLocalConversationId({
        alias: "run-550e8400-e29b-41d4-a716-446655440000",
        cwd: "/tmp/junior-local-one",
      }),
    ).toMatch(/^local:[a-f0-9]{12}:run-550e8400-e29b-41d4-a716-446655440000$/);
    expect(
      normalizeLocalConversationId({
        alias: "run-550e8400-e29b-41d4-a716-446655440000",
        cwd: "/tmp/junior-local-two",
      }),
    ).not.toBe(
      normalizeLocalConversationId({
        alias: "run-550e8400-e29b-41d4-a716-446655440000",
        cwd: "/tmp/junior-local-one",
      }),
    );
  });

  it("rejects invalid generated slugs", () => {
    expect(normalizeLocalConversationId({ alias: "" })).toBeUndefined();
    expect(normalizeLocalConversationId({ alias: "../demo" })).toBeUndefined();
    expect(
      normalizeLocalConversationId({ alias: "demo with spaces" }),
    ).toBeUndefined();
  });
});
