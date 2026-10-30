import { describe, expect, it } from "vitest";
import { isPublicAddress, publicAddressLookup } from "@/api/mcp/public-address";

describe("MCP public address rule", () => {
  it.each([
    ["10.1.2.3"],
    ["100.64.0.1"],
    ["127.0.0.1"],
    ["169.254.169.254"],
    ["172.16.0.1"],
    ["192.168.1.1"],
    ["0.0.0.0"],
    ["224.0.0.1"],
    ["255.255.255.255"],
    ["::"],
    ["::1"],
    ["::ffff:127.0.0.1"],
    ["::ffff:10.0.0.1"],
    ["64:ff9b::a00:1"],
    ["fc00::1"],
    ["fd00:ec2::254"],
    ["fe80::1"],
    ["fe90::1"],
    ["ff02::1"],
    ["not-an-ip"],
  ])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([["8.8.8.8"], ["1.1.1.1"], ["::ffff:8.8.8.8"], ["2606:4700::1111"]])(
    "allows %s",
    (address) => {
      expect(isPublicAddress(address)).toBe(true);
    },
  );

  it("fails a lookup that resolves to loopback", async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      publicAddressLookup("localhost", { all: true }, (lookupError) =>
        resolve(lookupError),
      );
    });

    expect(error?.code).toBe("EADDRNOTPUBLIC");
  });
});
