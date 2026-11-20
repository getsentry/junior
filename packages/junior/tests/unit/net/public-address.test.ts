import { describe, expect, it } from "vitest";
import { isPublicAddress, publicAddressLookup } from "@/net/public-address";

describe("public address rule", () => {
  it.each([
    ["10.1.2.3"],
    ["169.254.169.254"],
    ["::1"],
    ["fd00:ec2::254"],
    ["::ffff:127.0.0.1"],
    ["64:ff9b::a00:1"],
    ["2002:a00:1::1"],
  ])("blocks %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([["8.8.8.8"], ["2606:4700::1111"]])("allows %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("fails a lookup that resolves to loopback", async () => {
    const error = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
      publicAddressLookup("localhost", { all: true }, (lookupError) =>
        resolve(lookupError),
      );
    });

    expect(error?.code).toBe("EADDRNOTPUBLIC");
  });
});
