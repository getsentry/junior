import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  injectContinuationToolName,
  juniorToolResultSchema,
} from "@/chat/tool-support/structured-result";

function isToolContent(
  value: unknown,
): value is Array<TextContent | ImageContent> {
  return (
    Array.isArray(value) &&
    value.every((part) => {
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
    })
  );
}

function isStructuredToolExecutionResult(value: unknown): value is {
  content: Array<TextContent | ImageContent>;
  details: unknown;
} {
  const content = (value as { content?: unknown } | null)?.content;
  return (
    typeof value === "object" &&
    value !== null &&
    isToolContent(content) &&
    "details" in value
  );
}

function isContentOnlyToolExecutionResult(value: unknown): value is {
  content: Array<TextContent | ImageContent>;
} {
  const content = (value as { content?: unknown } | null)?.content;
  return (
    typeof value === "object" &&
    value !== null &&
    isToolContent(content) &&
    !("details" in value)
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

function withoutFirstGeneratedTextContent(
  content: Array<TextContent | ImageContent>,
): Array<TextContent | ImageContent> {
  const [first, ...rest] = content;
  if (first?.type === "text") {
    return rest;
  }
  return content;
}

function replaceGeneratedTextContent(
  content: Array<TextContent | ImageContent>,
  text: string,
): Array<TextContent | ImageContent> {
  return [
    {
      type: "text",
      text,
    },
    ...withoutFirstGeneratedTextContent(content),
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function hasContinuation(value: unknown): boolean {
  return isRecord(value) && isRecord(value.continuation);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function numberField(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
  if (signal.source !== "upstream") {
    return undefined;
  }
  const provider = stringField(signal, "provider");
  const message = stringField(signal, "message");
  const upstreamHost = stringField(signal, "upstreamHost");
  const upstreamPath = stringField(signal, "upstreamPath");
  const status = numberField(signal, "status");
  if (!provider || !message || !upstreamHost || !upstreamPath || !status) {
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
    `Status: ${status}`,
    ...(acceptedPermissions
      ? [`Accepted provider permissions: ${acceptedPermissions}`]
      : []),
    ...(sso ? [`Provider SSO: ${sso}`] : []),
    ...(command ? [`Command: ${command}`] : []),
    "",
    "Junior had a credential lease for this grant and forwarded the request. Do not diagnose this as a missing user token or a local Junior runtime block; diagnose provider-side permissions, installation scope, SSO, or actor-provider account access.",
    ...(stderr ? ["", `stderr:\n${stderr}`] : []),
    ...(stdout ? ["", `stdout:\n${stdout}`] : []),
  ].join("\n");
}

function unwrapSandboxResult(result: unknown, isSandboxResult: boolean) {
  return isSandboxResult &&
    result &&
    typeof result === "object" &&
    "result" in result
    ? (result as { result: unknown }).result
    : result;
}

function normalizeDetails(
  details: unknown,
  options: { requireStructuredResult?: boolean; toolName?: string },
): { details: unknown; replaceEnvelopeText: boolean } {
  const continuationToolName =
    options.toolName && hasContinuation(details) ? options.toolName : undefined;
  if (!options.requireStructuredResult && !continuationToolName) {
    return { details, replaceEnvelopeText: false };
  }

  const parsed = juniorToolResultSchema.parse(details);
  if (!continuationToolName) {
    return { details: parsed, replaceEnvelopeText: false };
  }

  return {
    details: injectContinuationToolName(parsed, continuationToolName),
    replaceEnvelopeText: true,
  };
}

/** Unwrap sandbox envelope and detect structured results. */
export function normalizeToolResult(
  result: unknown,
  isSandboxResult: boolean,
  options: { requireStructuredResult?: boolean; toolName?: string } = {},
): { content: Array<TextContent | ImageContent>; details: unknown } {
  const unwrapped = unwrapSandboxResult(result, isSandboxResult);

  if (isStructuredToolExecutionResult(unwrapped)) {
    const normalized = normalizeDetails(unwrapped.details, options);
    const permissionText = upstreamPermissionDeniedText(normalized.details);
    if (!permissionText && normalized.details === unwrapped.details) {
      return unwrapped;
    }
    const content =
      permissionText || normalized.replaceEnvelopeText
        ? replaceGeneratedTextContent(
            unwrapped.content,
            permissionText ?? toToolContentText(normalized.details),
          )
        : unwrapped.content;
    return {
      content,
      details: normalized.details,
    };
  }

  if (isContentOnlyToolExecutionResult(unwrapped)) {
    if (options.requireStructuredResult) {
      throw new TypeError(
        "Structured tools must return details matching their outputSchema.",
      );
    }
    return {
      content: unwrapped.content,
      details: { ok: true, status: "success" },
    };
  }

  const normalized = normalizeDetails(unwrapped, options);
  return {
    content: [
      {
        type: "text",
        text:
          upstreamPermissionDeniedText(normalized.details) ??
          toToolContentText(normalized.details),
      },
    ],
    details: normalized.details,
  };
}
