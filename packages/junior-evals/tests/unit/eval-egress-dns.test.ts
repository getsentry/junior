import { beforeEach, expect, it, vi } from "vitest";

const { resolve4, setServers } = vi.hoisted(() => ({
  resolve4: vi.fn(),
  setServers: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({
  Resolver: class {
    resolve4 = resolve4;
    setServers = setServers;
  },
}));

import { resolveQuickTunnelIpv4 } from "../../src/eval-egress";

beforeEach(() => {
  vi.resetAllMocks();
});

it("uses system DNS when the Quick Tunnel hostname is available", async () => {
  resolve4.mockResolvedValueOnce(["192.0.2.1"]);
  await expect(resolveQuickTunnelIpv4("ready.trycloudflare.com")).resolves.toBe(
    "192.0.2.1",
  );
  expect(setServers).not.toHaveBeenCalled();
});

it("tries each public provider independently after a negative DNS answer", async () => {
  resolve4
    .mockRejectedValueOnce(new Error("stale system DNS"))
    .mockRejectedValueOnce(
      Object.assign(new Error("queryA ENOTFOUND"), { code: "ENOTFOUND" }),
    )
    .mockResolvedValueOnce(["192.0.2.2"]);
  await expect(resolveQuickTunnelIpv4("new.trycloudflare.com")).resolves.toBe(
    "192.0.2.2",
  );
  expect(setServers.mock.calls).toEqual([[["1.1.1.1"]], [["8.8.8.8"]]]);
});

it("retains every DNS failure with its resolver", async () => {
  const failures = [
    new Error("system failed"),
    new Error("Cloudflare failed"),
    new Error("Google failed"),
  ];
  for (const failure of failures) resolve4.mockRejectedValueOnce(failure);
  await expect(
    resolveQuickTunnelIpv4("missing.trycloudflare.com"),
  ).rejects.toMatchObject({
    errors: failures.map((cause, index) => ({
      cause,
      message: `DNS lookup failed via ${["system", "1.1.1.1", "8.8.8.8"][index]}`,
    })),
    message:
      "Could not resolve missing.trycloudflare.com through system or public DNS",
  });
});
