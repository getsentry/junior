/**
 * Public Memory API.
 *
 * Apps and the `@sentry/junior-memory` compatibility package import Memory
 * from `@sentry/junior/memory`. Runtime registration happens inside
 * `createApp()`; this entry exposes stores, schemas, and types.
 */
export { createMemoryFeature, type MemoryOptions } from "@/chat/memory/feature";
export {
  memoryApiSchema,
  memoryDashboardResponseSchema,
  memoryListResponseSchema,
  type MemoryApi,
  type MemoryDashboardResponse,
  type MemoryListResponse,
} from "@/chat/memory/api";
export { createMemoryStore } from "@/chat/memory/store";
export type {
  ArchiveMemoryInput,
  CreateMemoryInput,
  CreateMemoryResult,
  ListMemoriesInput,
  MemoryDb,
  MemoryEmbeddingProvider,
  MemoryRecord,
  MemoryStore,
  MemoryStoreOptions,
  SearchMemoriesInput,
} from "@/chat/memory/store";
export { MEMORY_KINDS } from "@/chat/memory/types";
export type { MemoryKind, MemoryRuntimeContext } from "@/chat/memory/types";
