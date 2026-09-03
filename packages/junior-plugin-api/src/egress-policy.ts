import { EgressPolicyDenied } from "./credentials.js";

/**
 * Deny provider egress when a plugin policy does not allow the request.
 *
 * Call from a plugin `grantForEgress` hook before returning a write grant.
 */
export function enforceEgressPolicy(input: {
  allowed: boolean;
  denialMessage: string;
}): void {
  if (!input.allowed) {
    throw new EgressPolicyDenied(input.denialMessage);
  }
}
