import { isPluginConfigKey } from "@/chat/plugins/registry";

let installDefaults: Record<string, unknown> = {};

/** Store install-wide config defaults; keys must be registered plugin config keys. */
export function setConfigDefaults(
  defaults: Record<string, unknown> | undefined,
): void {
  if (!defaults) {
    installDefaults = {};
    return;
  }

  for (const key of Object.keys(defaults)) {
    if (!isPluginConfigKey(key)) {
      throw new Error(
        `configDefaults: "${key}" is not a registered plugin config key`,
      );
    }
  }

  installDefaults = { ...defaults };
}

/** Return the install-wide configuration defaults (empty object when none set). */
export function getConfigDefaults(): Record<string, unknown> {
  return installDefaults;
}
