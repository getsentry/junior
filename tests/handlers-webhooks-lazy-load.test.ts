import { describe, expect, it, vi } from "vitest";

vi.mock("@/chat/bot", () => {
  throw new Error("chat/bot must not be imported when loading handlers/webhooks");
});

describe("handlers webhooks module loading", () => {
  it("does not eagerly import chat bot on module load", async () => {
    const mod = await import("@/handlers/webhooks");
    expect(mod.runtime).toBe("nodejs");
    expect(typeof mod.POST).toBe("function");
  });
});
