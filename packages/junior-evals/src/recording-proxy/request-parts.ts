/**
 * The parts of a recorded request, for miss diagnosis.
 *
 * A recording keeps a short hash of each part of its request. When a new
 * request has no recording, the proxy finds the recording with the most
 * equal parts and reports the parts that differ, such as `messages[3]` or
 * `tools`. The parts are the method, the URL, the key headers, each
 * top-level field of a JSON body, and each item of a top-level array.
 *
 * Like the server, this file uses only Node built-ins.
 */
import { createHash } from "node:crypto";
import {
  extractValues,
  type RequestValues,
  type ValuePatterns,
} from "./values.ts";

/** A short hash of each part of a request, by part name. */
export type RequestParts = Record<string, string>;

/** The request fields that the key and the parts use. */
export interface KeyedRequest {
  body: string;
  /** The key headers, by lowercase name. */
  headers: Record<string, string>;
  method: string;
  url: string;
}

/** JSON with sorted object keys, so equal bodies give equal keys. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`)
    .join(",")}}`;
}

function parseJson(body: string): unknown {
  try {
    return body ? JSON.parse(body) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The body as the key sees it: sorted JSON, with each changing value as
 * `<<name>>`. Also returns the changing values, in their order.
 */
export function normalizeBody(
  body: string,
  patterns: ValuePatterns | undefined,
): { text: string; values: RequestValues } {
  const json = parseJson(body);
  return extractValues(
    json === undefined ? body : stableStringify(json),
    patterns,
  );
}

const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex").slice(0, 12);

/** The parts of a request. */
export function requestParts(
  request: KeyedRequest,
  patterns: ValuePatterns | undefined,
): RequestParts {
  const parts: RequestParts = {
    method: hash(request.method),
    url: hash(request.url),
  };
  for (const [name, value] of Object.entries(request.headers)) {
    parts[`header ${name}`] = hash(value);
  }
  const json = parseJson(request.body);
  if (json === null || typeof json !== "object" || Array.isArray(json)) {
    if (request.body) {
      parts.body = hash(normalizeBody(request.body, patterns).text);
    }
    return parts;
  }
  const part = (value: unknown) =>
    hash(extractValues(stableStringify(value), patterns).text);
  for (const [field, value] of Object.entries(json)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      parts[`${field}.length`] = hash(String(value.length));
      value.forEach((item, index) => {
        parts[`${field}[${index}]`] = part(item);
      });
    } else {
      parts[field] = part(value);
    }
  }
  return parts;
}

const partOrder = new Intl.Collator("en", { numeric: true }).compare;

/** The parts that differ, in a readable order. */
export function differentParts(a: RequestParts, b: RequestParts): string[] {
  const names = new Set([...Object.keys(a), ...Object.keys(b)]);
  return [...names].filter((name) => a[name] !== b[name]).sort(partOrder);
}

/**
 * The candidate with the most equal parts, and the parts that differ from
 * it. Returns `undefined` when there is no candidate.
 */
export function closestRequest<T extends { parts: RequestParts }>(
  parts: RequestParts,
  candidates: Iterable<T>,
): { candidate: T; differs: string[] } | undefined {
  let best: { candidate: T; differs: string[] } | undefined;
  let bestEqual = -1;
  for (const candidate of candidates) {
    const equal = Object.keys(parts).filter(
      (name) => candidate.parts[name] === parts[name],
    ).length;
    if (equal > bestEqual) {
      bestEqual = equal;
      best = { candidate, differs: differentParts(parts, candidate.parts) };
    }
  }
  return best;
}

/** Name some parts, such as `messages[3], tools`. */
export function describeParts(parts: string[]): string {
  if (parts.length === 0) return "no part";
  const shown = parts.slice(0, 6).join(", ");
  return parts.length > 6 ? `${shown} and ${parts.length - 6} more` : shown;
}
