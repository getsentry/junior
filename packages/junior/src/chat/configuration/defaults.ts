import {
  validateConfigKey,
  validateConfigValue,
} from "@/chat/configuration/validation";

let installDefaults: Record<string, unknown> = {};

/**
 * Store install-wide configuration defaults provided by the deployer.
 *
 * Called once at startup from `createApp()`. Keys are validated against
 * the standard config-key format (`provider.key`) and values are screened
 * for accidental secret material.
 */
export function setConfigDefaults(
  defaults: Record<string, unknown> | undefined,
): void {
  if (!defaults) {
    installDefaults = {};
    return;
  }

  for (const [key, value] of Object.entries(defaults)) {
    const keyError = validateConfigKey(key);
    if (keyError) {
      throw new Error(`configDefaults: ${keyError}`);
    }
    const valueError = validateConfigValue(value);
    if (valueError) {
      throw new Error(`configDefaults["${key}"]: ${valueError}`);
    }
  }

  installDefaults = { ...defaults };
}

/** Return the install-wide configuration defaults (empty object when none set). */
export function getConfigDefaults(): Record<string, unknown> {
  return installDefaults;
}
