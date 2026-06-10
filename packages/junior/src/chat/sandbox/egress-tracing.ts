let tracePropagationDomains: string[] = [];

function isValidDomainPattern(domain: string): boolean {
  if (domain.includes("*")) {
    return domain.startsWith("*.") && domain.indexOf("*", 1) === -1;
  }
  return true;
}

function normalizeDomains(domains: string[] | undefined): string[] {
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

/** Store the sandbox egress domains that may carry trace propagation headers. */
export function setSandboxEgressTracePropagationDomains(
  domains: string[] | undefined,
): string[] {
  const previous = tracePropagationDomains;
  tracePropagationDomains = normalizeDomains(domains);
  return previous;
}

/** Return sandbox egress domains that may carry trace propagation headers. */
export function getSandboxEgressTracePropagationDomains(): string[] {
  return [...tracePropagationDomains];
}

/** Return whether a sandbox egress host may carry trace propagation headers. */
export function shouldPropagateSandboxEgressTrace(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return tracePropagationDomains.some((domain) => {
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(1);
      return (
        normalizedHost.endsWith(suffix) && normalizedHost !== domain.slice(2)
      );
    }
    return domain === normalizedHost;
  });
}
