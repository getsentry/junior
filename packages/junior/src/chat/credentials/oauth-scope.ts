function parseScope(scope?: string): string[] {
  if (!scope) {
    return [];
  }

  return [...new Set(scope.split(/\s+/).filter(Boolean))].sort();
}

/** Normalize OAuth scope strings so persisted grants can be compared reliably. */
export function normalizeOAuthScope(scope?: string): string | undefined {
  const parsed = parseScope(scope);
  return parsed.length > 0 ? parsed.join(" ") : undefined;
}

/** Return whether the stored grant still satisfies the provider's current scope contract. */
export function hasRequiredOAuthScope(
  storedScope?: string,
  requiredScope?: string,
): boolean {
  const required = parseScope(requiredScope);
  if (required.length === 0) {
    return true;
  }

  const stored = new Set(parseScope(storedScope));
  if (stored.size === 0) {
    return false;
  }

  return required.every((scope) => stored.has(scope));
}
