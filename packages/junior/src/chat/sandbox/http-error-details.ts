const DEFAULT_PREVIEW_LIMIT = 512;

interface HttpErrorResponseLike {
  status?: unknown;
  statusText?: unknown;
  url?: unknown;
  headers?: {
    get?: (name: string) => string | null;
  };
}

interface HttpErrorLike {
  response?: HttpErrorResponseLike;
  text?: unknown;
  json?: unknown;
  [key: string]: unknown;
}

interface ExtraFieldOption {
  sourceKey: string;
  attributeKey: string;
  summaryKey?: string;
}

export interface ExtractHttpErrorDetailsOptions {
  attributePrefix?: string;
  previewLimit?: number;
  extraFields?: ExtraFieldOption[];
}

export interface ExtractedHttpErrorDetails {
  attributes: Record<string, string | number | boolean | string[]>;
  summary: string;
  searchableText: string;
}

function toTrimmedString(value: unknown, maxChars: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) {
    return undefined;
  }
  return normalized.length > maxChars
    ? `${normalized.slice(0, maxChars)}…`
    : normalized;
}

/** Extract structured HTTP error metadata (status, headers, body preview) for logging. */
export function extractHttpErrorDetails(
  error: unknown,
  options: ExtractHttpErrorDetailsOptions = {},
): ExtractedHttpErrorDetails {
  const prefix = options.attributePrefix ?? "app.http_error";
  const previewLimit = options.previewLimit ?? DEFAULT_PREVIEW_LIMIT;
  const normalizedError =
    error instanceof Error ? error : new Error(String(error));
  const err = (error ?? {}) as HttpErrorLike;

  const attributes: Record<string, string | number | boolean | string[]> = {
    "error.type": normalizedError.name || "Error",
    "error.message":
      toTrimmedString(normalizedError.message, previewLimit) ?? "HTTP error",
  };

  const response = err.response;
  const statusCode =
    typeof response?.status === "number" ? response.status : undefined;
  const statusText = toTrimmedString(response?.statusText, previewLimit);
  const responseUrl = toTrimmedString(response?.url, previewLimit);
  const responseText = toTrimmedString(err.text, previewLimit);
  const responseJson = toTrimmedString(
    err.json && typeof err.json === "object"
      ? JSON.stringify(err.json)
      : undefined,
    previewLimit,
  );
  const contentType = toTrimmedString(
    response?.headers?.get?.("content-type"),
    previewLimit,
  );
  const requestIdHeader = toTrimmedString(
    response?.headers?.get?.("x-request-id"),
    previewLimit,
  );
  const vercelIdHeader = toTrimmedString(
    response?.headers?.get?.("x-vercel-id"),
    previewLimit,
  );
  const requestId = requestIdHeader ?? vercelIdHeader;

  if (statusCode !== undefined) {
    attributes["http.response.status_code"] = statusCode;
  }
  if (statusText) {
    attributes[`${prefix}.status_text`] = statusText;
  }
  if (responseUrl) {
    attributes["url.full"] = responseUrl;
  }
  if (contentType) {
    attributes["http.response.header.content-type"] = [contentType];
  }
  if (requestIdHeader) {
    attributes["http.response.header.x-request-id"] = [requestIdHeader];
  }
  if (vercelIdHeader) {
    attributes["http.response.header.x-vercel-id"] = [vercelIdHeader];
  }
  if (responseText) {
    attributes[`${prefix}.response_text_preview`] = responseText;
    attributes[`${prefix}.response_text_length`] = responseText.length;
  }
  if (responseJson) {
    attributes[`${prefix}.response_json_preview`] = responseJson;
  }

  const summaryParts: string[] = [];
  if (statusCode !== undefined) {
    summaryParts.push(`status=${statusCode}`);
  }
  if (statusText) {
    summaryParts.push(`statusText=${statusText}`);
  }
  if (responseUrl) {
    summaryParts.push(`url=${responseUrl}`);
  }
  if (requestId) {
    summaryParts.push(`requestId=${requestId}`);
  }

  for (const field of options.extraFields ?? []) {
    const value = toTrimmedString(err[field.sourceKey], previewLimit);
    if (!value) {
      continue;
    }
    attributes[`${prefix}.${field.attributeKey}`] = value;
    summaryParts.push(`${field.summaryKey ?? field.attributeKey}=${value}`);
  }

  if (responseJson) {
    summaryParts.push(`json=${responseJson}`);
  } else if (responseText) {
    summaryParts.push(`text=${responseText}`);
  }

  const searchableText =
    `${normalizedError.message} ${responseText ?? ""} ${responseJson ?? ""}`.toLowerCase();
  return {
    attributes,
    summary: summaryParts.join(", "),
    searchableText,
  };
}
