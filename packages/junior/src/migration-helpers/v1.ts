import type { Destination } from "@sentry/junior-plugin-api";
import {
  isRecord as runtimeIsRecord,
  toOptionalNumber as runtimeToOptionalNumber,
  toOptionalString as runtimeToOptionalString,
} from "@/chat/coerce";
import {
  parseDestination as runtimeParseDestination,
  sameDestination as runtimeSameDestination,
} from "@/chat/destination";
import { unescapeXml } from "@/chat/xml";

/** Return whether a value is a non-null object record. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return runtimeIsRecord(value);
}

/** Return a finite number or undefined. */
export function toOptionalNumber(value: unknown): number | undefined {
  return runtimeToOptionalNumber(value);
}

/** Return a non-empty string or undefined. */
export function toOptionalString(value: unknown): string | undefined {
  return runtimeToOptionalString(value);
}

/** Parse one persisted destination through the stable destination schema. */
export function parseDestination(value: unknown): Destination | undefined {
  return runtimeParseDestination(value);
}

/** Compare two persisted destinations by routing identity. */
export function sameDestination(
  left: Destination,
  right: Destination,
): boolean {
  return runtimeSameDestination(left, right);
}

/** Unescape one persisted XML text fragment. */
export function migrationUnescapeXml(value: string): string {
  return unescapeXml(value);
}
