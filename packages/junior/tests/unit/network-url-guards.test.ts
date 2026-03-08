import { beforeEach, describe, expect, it, vi } from "vitest";

const { lookupMock } = vi.hoisted(() => ({
  lookupMock: vi.fn()
}));

vi.mock("node:dns/promises", () => ({
  default: {
    lookup: lookupMock
  }
}));

import { assertPublicUrl } from "@/chat/tools/network";

describe("network URL guards", () => {
  beforeEach(() => {
    lookupMock.mockReset();
  });

  it("blocks IPv4-mapped IPv6 loopback addresses", async () => {
    await expect(assertPublicUrl("http://[::ffff:127.0.0.1]/"))
      .rejects
      .toThrow("Private IPv6 addresses are blocked");
  });

  it("blocks IPv6 link-local addresses across fe80::/10", async () => {
    await expect(assertPublicUrl("http://[fe90::1]/"))
      .rejects
      .toThrow("Private IPv6 addresses are blocked");
  });

  it("blocks hostnames that resolve to IPv4-mapped private IPv6", async () => {
    lookupMock.mockResolvedValue([
      { address: "::ffff:127.0.0.1", family: 6 }
    ]);

    await expect(assertPublicUrl("https://example.com/path"))
      .rejects
      .toThrow("Resolved to a private IPv6 address");
  });
});
