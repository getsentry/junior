import type { Platform, Requester, Source } from "@sentry/junior-plugin-api";

export const MEMORY_TYPES = [
  "preference",
  "identity",
  "relationship",
  "knowledge",
  "context",
  "event",
  "task",
  "observation",
] as const;

export const MEMORY_SCOPES = ["personal", "conversation"] as const;
export const MEMORY_SENSITIVITIES = [
  "public",
  "personal",
  "sensitive",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];
export type MemoryScope = (typeof MEMORY_SCOPES)[number];
export type MemorySensitivity = (typeof MEMORY_SENSITIVITIES)[number];

export interface MemoryRuntimeContext {
  conversationId?: string;
  requester?: Requester;
  source: Source;
}

export interface MemoryRecord {
  archivedAtMs?: number;
  archiveReason?: string;
  content: string;
  contentHash: string;
  createdAtMs: number;
  expiresAtMs?: number;
  id: string;
  idempotencyKey?: string;
  observedAtMs: number;
  scope: MemoryScope;
  scopeKey: string;
  sensitivity: MemorySensitivity;
  sourceKey: string;
  sourcePlatform: Platform;
  supersededAtMs?: number;
  supersededById?: string;
  type: MemoryType;
}
