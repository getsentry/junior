import { isPluginConfigKey } from "@/chat/plugins/registry";

let installDefaults: Record<string, unknown> = {};

function cloneDefaults(
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  return structuredClone(defaults) as Record<string, unknown>;
}

function isConfigDefaultsRecord(
  defaults: unknown,
): defaults is Record<string, unknown> {
  return (
    typeof defaults === "object" &&
    defaults !== null &&
    !Array.isArray(defaults)
  );
}

/** Store install-wide config defaults; keys must be registered plugin config keys. */
export function setConfigDefaults(
  defaults: Record<string, unknown> | undefined,
): void {
  if (defaults === undefined) {
    installDefaults = {};
    return;
  }

  if (!isConfigDefaultsRecord(defaults)) {
    throw new Error(
      "configDefaults must be an object keyed by plugin config key",
    );
  }

  for (const key of Object.keys(defaults)) {
    if (!isPluginConfigKey(key)) {
      throw new Error(
        `configDefaults: "${key}" is not a registered plugin config key`,
      );
    }
  }

  installDefaults = cloneDefaults(defaults);
}

/** Return the install-wide configuration defaults (empty object when none set). */
export function getConfigDefaults(): Record<string, unknown> {
  return cloneDefaults(installDefaults);
}
