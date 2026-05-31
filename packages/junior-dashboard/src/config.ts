import type { JuniorDashboardOptions } from "./app";

export type JuniorDashboardRuntimeConfig = Omit<
  JuniorDashboardOptions,
  "auth" | "reporting"
>;

/** Read dashboard runtime config injected by the Nitro module. */
export async function resolveDashboardConfig(): Promise<JuniorDashboardRuntimeConfig> {
  try {
    const mod: { dashboard?: JuniorDashboardRuntimeConfig } =
      await import("#junior-dashboard/config");
    return mod.dashboard ?? readEnvConfig();
  } catch (error) {
    if (!isMissingVirtualConfig(error)) {
      throw error;
    }
    return readEnvConfig();
  }
}

function readEnvConfig(): JuniorDashboardRuntimeConfig {
  return {
    authRequired: process.env.JUNIOR_DASHBOARD_AUTH_REQUIRED !== "false",
    allowedGoogleDomains: readListEnv("JUNIOR_DASHBOARD_GOOGLE_DOMAINS"),
    allowedEmails: readListEnv("JUNIOR_DASHBOARD_ALLOWED_EMAILS"),
    trustedOrigins: readListEnv("JUNIOR_DASHBOARD_TRUSTED_ORIGINS"),
  };
}

function readListEnv(name: string): string[] {
  const value = process.env[name];
  if (!value?.trim()) {
    return [];
  }

  if (value.trim().startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      throw new Error(`${name} must be a JSON string array`, {
        cause: error,
      });
    }
    if (
      !Array.isArray(parsed) ||
      parsed.some((item) => typeof item !== "string")
    ) {
      throw new Error(`${name} must be a JSON string array`);
    }
    return parsed;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isMissingVirtualConfig(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const code = (error as { code?: string }).code;
  return (
    (code === "ERR_PACKAGE_IMPORT_NOT_DEFINED" ||
      code === "ERR_MODULE_NOT_FOUND" ||
      code === "MODULE_NOT_FOUND") &&
    error.message.includes("#junior-dashboard/config")
  );
}
