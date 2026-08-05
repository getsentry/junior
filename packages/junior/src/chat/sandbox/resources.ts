export interface SandboxResourceConfig {
  vcpus?: number;
}

let configuredResources: { vcpus: number } | undefined;

function resourcesFromEnv(): { vcpus: number } | undefined {
  const value = process.env.SANDBOX_VCPUS?.trim();
  if (!value || !/^\d+$/.test(value)) {
    return undefined;
  }
  const vcpus = Number(value);
  if (!Number.isSafeInteger(vcpus) || vcpus <= 0) {
    return undefined;
  }
  return { vcpus };
}

/** Return the app-level sandbox sizing override. */
export function getSandboxResourceConfig(): { vcpus: number } | undefined {
  return configuredResources;
}

/** Replace app-level sandbox sizing and return the previous setting. */
export function setSandboxResourceConfig(
  config?: SandboxResourceConfig,
): { vcpus: number } | undefined {
  const previous = configuredResources;
  if (config?.vcpus === undefined) {
    configuredResources = undefined;
    return previous;
  }
  if (!Number.isSafeInteger(config.vcpus) || config.vcpus <= 0) {
    throw new Error("sandbox.vcpus must be a positive integer");
  }
  configuredResources = { vcpus: config.vcpus };
  return previous;
}

/** Resolve app-level sandbox sizing, falling back to the legacy environment setting. */
export function getSandboxResources(): { vcpus: number } | undefined {
  return configuredResources ?? resourcesFromEnv();
}
