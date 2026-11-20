let installDefaults: Record<string, unknown> = {};

function cloneDefaults(
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  return structuredClone(defaults);
}

/** Store install-wide configuration defaults. */
export function setConfigDefaults(defaults: unknown): void {
  if (defaults === undefined) {
    installDefaults = {};
    return;
  }

  if (
    typeof defaults !== "object" ||
    defaults === null ||
    Array.isArray(defaults)
  ) {
    throw new Error(
      "configDefaults must be an object keyed by plugin config key",
    );
  }

  installDefaults = cloneDefaults(Object.fromEntries(Object.entries(defaults)));
}

/** Return the install-wide configuration defaults (empty object when none set). */
export function getConfigDefaults(): Record<string, unknown> {
  return cloneDefaults(installDefaults);
}
