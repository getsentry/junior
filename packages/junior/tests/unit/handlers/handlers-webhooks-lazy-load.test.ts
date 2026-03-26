import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalSigningSecret = process.env.SLACK_SIGNING_SECRET;
const originalRedisUrl = process.env.REDIS_URL;

describe("handlers webhooks module loading", () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.SLACK_SIGNING_SECRET;
    delete process.env.REDIS_URL;
  });

  afterEach(() => {
    if (originalSigningSecret === undefined) {
      delete process.env.SLACK_SIGNING_SECRET;
    } else {
      process.env.SLACK_SIGNING_SECRET = originalSigningSecret;
    }

    if (originalRedisUrl === undefined) {
      delete process.env.REDIS_URL;
    } else {
      process.env.REDIS_URL = originalRedisUrl;
    }
  });

  it("loads without requiring runtime env on module load", async () => {
    const mod = await import("@/handlers/webhooks");
    expect(typeof mod.POST).toBe("function");
  });
});
