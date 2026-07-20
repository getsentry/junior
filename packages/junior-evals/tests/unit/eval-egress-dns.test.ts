import { beforeEach, expect, it, vi } from "vitest";

const { publicResolve4, setServers, systemResolve4 } = vi.hoisted(() => ({
  publicResolve4: vi.fn(),
  setServers: vi.fn(),
  systemResolve4: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolve4 = publicResolve4;
    setServers = setServers;
  },
  resolve4: systemResolve4,
}));

import { resolveQuickTunnelIpv4 } from "../../src/eval-egress";

beforeEach(() => {
  vi.clearAllMocks();
});

it("uses system DNS when the Quick Tunnel hostname is available", async () => {
  systemResolve4.mockResolvedValueOnce(["192.0.2.1"]);

  await expect(resolveQuickTunnelIpv4("ready.trycloudflare.com")).resolves.toBe(
    "192.0.2.1",
  );
  expect(publicResolve4).not.toHaveBeenCalled();
});

it("falls back to public DNS when system DNS is stale", async () => {
  systemResolve4.mockRejectedValueOnce(new Error("stale system DNS"));
  publicResolve4.mockResolvedValueOnce(["192.0.2.2"]);

  await expect(resolveQuickTunnelIpv4("new.trycloudflare.com")).resolves.toBe(
    "192.0.2.2",
  );
  expect(setServers).toHaveBeenCalledWith(["1.1.1.1", "8.8.8.8"]);
});

it("reports both DNS failures", async () => {
  const systemError = new Error("system DNS failed");
  const publicError = new Error("public DNS failed");
  systemResolve4.mockRejectedValueOnce(systemError);
  publicResolve4.mockRejectedValueOnce(publicError);

  await expect(
    resolveQuickTunnelIpv4("missing.trycloudflare.com"),
  ).rejects.toEqual(
    expect.objectContaining({
      errors: [systemError, publicError],
      message:
        "Could not resolve missing.trycloudflare.com through system or public DNS",
    }),
  );
});
