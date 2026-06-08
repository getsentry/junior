import type { ImageContent, TextContent } from "@earendil-works/pi-ai";

function isStructuredToolExecutionResult(value: unknown): value is {
  content: Array<TextContent | ImageContent>;
  details: unknown;
} {
  const content = (value as { content?: unknown } | null)?.content;
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray(content) &&
    content.every((part) => {
      if (!part || typeof part !== "object") {
        return false;
      }
      const record = part as Record<string, unknown>;
      if (record.type === "text") {
        return typeof record.text === "string";
      }
      if (record.type === "image") {
        return (
          typeof record.data === "string" && typeof record.mimeType === "string"
        );
      }
      return false;
    }) &&
    "details" in value
  );
}

function toToolContentText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function stringListField(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function accountText(value: unknown): string | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const label = stringField(value, "label") || stringField(value, "id");
  const id = stringField(value, "id");
  if (!label) {
    return undefined;
  }
  return id && id !== label ? `${label} (${id})` : label;
}

function upstreamPermissionDeniedText(value: unknown): string | undefined {
  if (!isRecord(value) || !isRecord(value.permission_denied)) {
    return undefined;
  }
  const signal = value.permission_denied;
  if (signal.source !== "upstream" || signal.status !== 403) {
    return undefined;
  }
  const provider = stringField(signal, "provider");
  const message = stringField(signal, "message");
  const upstreamHost = stringField(signal, "upstreamHost");
  const upstreamPath = stringField(signal, "upstreamPath");
  if (!provider || !message || !upstreamHost || !upstreamPath) {
    return undefined;
  }
  const grant = isRecord(signal.grant) ? signal.grant : {};
  const grantName = stringField(grant, "name");
  const grantAccess = stringField(grant, "access");
  const grantReason = stringField(grant, "reason");
  const grantRequirements = stringListField(grant, "requirements");
  const account = accountText(signal.account);
  const command = stringField(value, "command");
  const stderr = stringField(value, "stderr").trim();
  const stdout = stringField(value, "stdout").trim();
  const acceptedPermissions = stringField(signal, "acceptedPermissions");
  const sso = stringField(signal, "sso");

  return [
    "Upstream permission denied.",
    message,
    "",
    `Provider: ${provider}`,
    ...(account ? [`Provider account: ${account}`] : []),
    `Grant: ${grantName || "unknown"}${grantAccess ? ` (${grantAccess}${grantReason ? `, ${grantReason}` : ""})` : ""}`,
    ...(grantRequirements.length > 0
      ? [
          "Provider requirements:",
          ...grantRequirements.map((item) => `- ${item}`),
        ]
      : []),
    `Upstream: ${upstreamHost}${upstreamPath}`,
    "Status: 403",
    ...(acceptedPermissions
      ? [`Accepted provider permissions: ${acceptedPermissions}`]
      : []),
    ...(sso ? [`Provider SSO: ${sso}`] : []),
    ...(command ? [`Command: ${command}`] : []),
    "",
    "Junior had a credential lease for this grant and forwarded the request. Do not diagnose this as a missing user token or a local Junior runtime block; diagnose provider-side permissions, installation scope, SSO, or requester-provider account access.",
    ...(stderr ? ["", `stderr:\n${stderr}`] : []),
    ...(stdout ? ["", `stdout:\n${stdout}`] : []),
  ].join("\n");
}

/** Unwrap sandbox envelope and detect structured results. */
export function normalizeToolResult(
  result: unknown,
  isSandboxResult: boolean,
): { content: Array<TextContent | ImageContent>; details: unknown } {
  const unwrapped =
    isSandboxResult &&
    result &&
    typeof result === "object" &&
    "result" in result
      ? (result as { result: unknown }).result
      : result;

  if (isStructuredToolExecutionResult(unwrapped)) {
    return unwrapped;
  }

  return {
    content: [
      {
        type: "text",
        text:
          upstreamPermissionDeniedText(unwrapped) ??
          toToolContentText(unwrapped),
      },
    ],
    details: unwrapped,
  };
}
