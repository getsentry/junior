import { describe, expect, it } from "vitest";
import {
  isLocalConversationAlias,
  normalizeLocalConversationId,
} from "@/chat/local/conversation";

describe("local conversation ids", () => {
  it("normalizes aliases into local conversation ids scoped by cwd", () => {
    expect(
      normalizeLocalConversationId({
        alias: "Demo.Thread",
        cwd: "/tmp/junior-local-one",
      }),
    ).toMatch(/^local:[a-f0-9]{12}:demo-thread$/);
    expect(
      normalizeLocalConversationId({
        alias: "Demo.Thread",
        cwd: "/tmp/junior-local-two",
      }),
    ).not.toBe(
      normalizeLocalConversationId({
        alias: "Demo.Thread",
        cwd: "/tmp/junior-local-one",
      }),
    );
  });

  it("uses default when no alias is provided", () => {
    expect(
      normalizeLocalConversationId({
        cwd: "/tmp/junior-local-default",
      }),
    ).toMatch(/^local:[a-f0-9]{12}:default$/);
  });

  it("rejects invalid aliases", () => {
    expect(isLocalConversationAlias("demo")).toBe(true);
    expect(isLocalConversationAlias("")).toBe(false);
    expect(isLocalConversationAlias("../demo")).toBe(false);
    expect(isLocalConversationAlias("demo with spaces")).toBe(false);
    expect(normalizeLocalConversationId({ alias: "../demo" })).toBeUndefined();
  });
});
