/**
 * Own the public-address rule for MCP client metadata fetches.
 *
 * A client ID is a URL that any person can submit. Junior must not fetch it
 * from loopback, private, link-local, cloud metadata, or other special
 * addresses. The lookup checks every resolved address at connect time, so a
 * second DNS answer cannot move the request to a blocked address.
 */
import dns from "node:dns";
import net from "node:net";

/** Special-use ranges from RFC 6890 and the IANA special-purpose registries. */
const BLOCKED_SUBNETS: ReadonlyArray<
  readonly [network: string, prefix: number, family: "ipv4" | "ipv6"]
> = [
  ["0.0.0.0", 8, "ipv4"],
  ["10.0.0.0", 8, "ipv4"],
  ["100.64.0.0", 10, "ipv4"],
  ["127.0.0.0", 8, "ipv4"],
  // Link-local, including the 169.254.169.254 cloud metadata address.
  ["169.254.0.0", 16, "ipv4"],
  ["172.16.0.0", 12, "ipv4"],
  ["192.0.0.0", 24, "ipv4"],
  ["192.0.2.0", 24, "ipv4"],
  ["192.168.0.0", 16, "ipv4"],
  ["198.18.0.0", 15, "ipv4"],
  ["198.51.100.0", 24, "ipv4"],
  ["203.0.113.0", 24, "ipv4"],
  ["224.0.0.0", 4, "ipv4"],
  ["240.0.0.0", 4, "ipv4"],
  ["::", 128, "ipv6"],
  ["::1", 128, "ipv6"],
  // NAT64 prefixes can reach private IPv4 networks.
  ["64:ff9b::", 96, "ipv6"],
  ["64:ff9b:1::", 48, "ipv6"],
  ["100::", 64, "ipv6"],
  ["2001:db8::", 32, "ipv6"],
  ["fc00::", 7, "ipv6"],
  ["fe80::", 10, "ipv6"],
  ["ff00::", 8, "ipv6"],
];

function blockedAddressList(): net.BlockList {
  const list = new net.BlockList();
  for (const [network, prefix, family] of BLOCKED_SUBNETS) {
    list.addSubnet(network, prefix, family);
  }
  return list;
}

// Node applies IPv4 rules to IPv4-mapped IPv6 addresses too.
const blockedAddresses = blockedAddressList();

/** Return true only for an IP address outside every blocked range. */
export function isPublicAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6");
}

function blockedAddressError(hostname: string): NodeJS.ErrnoException {
  return Object.assign(
    new Error(`${hostname} does not resolve to a public address`),
    { code: "EADDRNOTPUBLIC" },
  );
}

/**
 * Resolve a hostname for an outbound socket. Fail when any answer is not a
 * public address.
 */
export const publicAddressLookup: net.LookupFunction = (
  hostname,
  options,
  callback,
) => {
  dns.lookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 0);
      return;
    }
    const allowed = addresses.filter(
      (entry) =>
        !options.family ||
        entry.family === options.family ||
        `IPv${entry.family}` === options.family,
    );
    const first = allowed[0];
    if (!first || !addresses.every((entry) => isPublicAddress(entry.address))) {
      callback(blockedAddressError(hostname), "", 0);
      return;
    }
    if (options.all) {
      callback(null, allowed);
      return;
    }
    callback(null, first.address, first.family);
  });
};
