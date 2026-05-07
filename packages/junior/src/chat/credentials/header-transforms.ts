import type { CredentialHeaderTransform } from "@/chat/credentials/broker";

/** Merge transforms by domain so later transforms override earlier headers. */
export function mergeHeaderTransforms(
  transforms: CredentialHeaderTransform[],
): CredentialHeaderTransform[] {
  const byDomain = new Map<string, Record<string, string>>();
  for (const transform of transforms) {
    byDomain.set(transform.domain, {
      ...(byDomain.get(transform.domain) ?? {}),
      ...transform.headers,
    });
  }
  return [...byDomain.entries()].map(([domain, headers]) => ({
    domain,
    headers,
  }));
}
