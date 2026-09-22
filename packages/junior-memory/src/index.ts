/**
 * Compatibility package for apps that still depend on `@sentry/junior-memory`.
 *
 * Memory is a Junior core feature. `@sentry/junior` registers it inside
 * `createApp()`, and `@sentry/junior/memory` owns the supported API. This
 * package re-exports that API and accepts the old `memoryPlugin()` call so
 * existing `plugins.ts` files keep loading during the compatibility window.
 */
import type { PluginRegistration } from "@sentry/junior-plugin-api";

export {
  createMemoryStore,
  MEMORY_KINDS,
  memoryApiSchema,
  memoryDashboardResponseSchema,
  memoryListResponseSchema,
  type ArchiveMemoryInput,
  type CreateMemoryInput,
  type CreateMemoryResult,
  type ListMemoriesInput,
  type MemoryApi,
  type MemoryDashboardResponse,
  type MemoryDb,
  type MemoryEmbeddingProvider,
  type MemoryKind,
  type MemoryListResponse,
  type MemoryRecord,
  type MemoryRuntimeContext,
  type MemoryStore,
  type MemoryStoreOptions,
  type SearchMemoriesInput,
} from "@sentry/junior/memory";

/** Legacy `memoryPlugin()` options. Configure `createApp({ memory })` instead. */
export interface MemoryPluginOptions {
  /** @deprecated Use `createApp({ memory: { disableRecall: true } })`. */
  disableRecall?: boolean;
  /** @deprecated Use `createApp({ memory: { disableExtraction: true } })`. */
  disableExtraction?: boolean;
  /** @deprecated Use `createApp({ memory: { modelId } })` or `AI_MEMORY_MODEL`. */
  modelId?: string;
}

/**
 * Deprecated marker kept for existing plugin sets.
 *
 * `@sentry/junior` ignores this registration with one startup warning and
 * serves Memory from core. The options no longer take effect; move them to
 * `createApp({ memory })`.
 *
 * @deprecated Remove `memoryPlugin()` from `defineJuniorPlugins([...])`.
 */
export function memoryPlugin(
  _options: MemoryPluginOptions = {},
): PluginRegistration {
  return {
    manifest: {
      name: "memory",
      displayName: "Memory",
      description: "Long-term Junior memory storage and recall",
    },
    packageName: "@sentry/junior-memory",
  };
}
