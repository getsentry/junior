export interface SandboxEgressTracePropagationConfig {
  domains?: string[];
}

function isValidDomainPattern(domain: string): boolean {
  if (domain.includes("*")) {
    return domain.startsWith("*.") && domain.indexOf("*", 1) === -1;
  }
  return true;
}

/** Normalize exact and leading-wildcard sandbox egress trace domains. */
export function normalizeSandboxEgressTracePropagationDomains(
  domains: string[] | undefined,
): string[] {
  if (domains === undefined) {
    return [];
  }

  if (!Array.isArray(domains)) {
    throw new Error("sandbox.egressTracePropagationDomains must be an array");
  }

  return [
    ...new Set(
      domains.map((domain) => {
        if (typeof domain !== "string") {
          throw new Error(
            "sandbox.egressTracePropagationDomains entries must be strings",
          );
        }
        const normalized = domain.trim().toLowerCase();
        if (!normalized) {
          throw new Error(
            "sandbox.egressTracePropagationDomains entries must be non-empty",
          );
        }
        if (!isValidDomainPattern(normalized)) {
          throw new Error(
            "sandbox.egressTracePropagationDomains entries must be exact domains or leading wildcard domains",
          );
        }
        return normalized;
      }),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

/** Return whether a host may carry sandbox egress trace propagation headers. */
export function shouldPropagateSandboxEgressTrace(
  host: string,
  config: SandboxEgressTracePropagationConfig = {},
): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (config.domains ?? []).some((domain) => {
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(1);
      return (
        normalizedHost.endsWith(suffix) && normalizedHost !== domain.slice(2)
      );
    }
    return domain === normalizedHost;
  });
}
