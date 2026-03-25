import { describe, expect, it, vi } from "vitest";

vi.mock("@/chat/app/production", () => {
  throw new Error(
    "chat/app/production must not be imported when loading handlers/queue-callback",
  );
});

describe("handlers queue callback module loading", () => {
  it("does not eagerly import production runtime on module load", async () => {
    const mod = await import("@/handlers/queue-callback");
    expect(typeof mod.POST).toBe("function");
  });
});
