import type { CapabilityProviderTargetDefinition } from "@/chat/capabilities/catalog";
import type { CapabilityTarget } from "@/chat/capabilities/types";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeTargetValue(value: string): string | undefined {
  let normalized = value.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }

  return normalized || undefined;
}

function extractFlagValue(text: string, flags: string[]): string | undefined {
  if (flags.length === 0) {
    return undefined;
  }

  const pattern = flags.map(escapeRegExp).join("|");
  const match = new RegExp(
    String.raw`(?:^|\s)(?:${pattern})(?:\s+|=)([^\s]+)`,
  ).exec(text);
  return match ? normalizeTargetValue(match[1] ?? "") : undefined;
}

export function createCapabilityTarget(
  type: string,
  value: string,
): CapabilityTarget | undefined {
  const normalizedType = type.trim();
  const normalizedValue = normalizeTargetValue(value);
  if (!normalizedType || !normalizedValue) {
    return undefined;
  }

  return {
    type: normalizedType,
    value: normalizedValue,
  };
}

export function extractCapabilityTarget(params: {
  commandText?: string;
  invocationArgs?: string;
  target: CapabilityProviderTargetDefinition;
}): CapabilityTarget | undefined {
  const flags = params.target.commandFlags ?? [];
  if (params.commandText) {
    const value = extractFlagValue(params.commandText, flags);
    if (value) {
      return createCapabilityTarget(params.target.type, value);
    }
  }

  if (params.invocationArgs) {
    const value = extractFlagValue(params.invocationArgs, flags);
    if (value) {
      return createCapabilityTarget(params.target.type, value);
    }
  }

  return undefined;
}
