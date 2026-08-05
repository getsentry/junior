import type { MemoryRecord } from "./store";

/** Return self-contained model-visible content without exposing subject keys. */
export function presentedMemoryContent(
  memory: MemoryRecord,
): string | undefined {
  if (memory.subjectType !== "user") return memory.content;
  if (memory.subjectLabel) {
    return `About ${memory.subjectLabel}: ${memory.content}`;
  }
  return memory.scope === "personal" ? memory.content : undefined;
}
