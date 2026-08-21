import { createMemory, type CreateMemoryInput } from "../src/create";
import * as memories from "../src/memories";
import { retrieveMemories, type RetrieveMemoriesInput } from "../src/retrieval";
import type { MemoryRuntimeContext } from "../src/types";

interface MemoryFixture {
  context: MemoryRuntimeContext;
  db: memories.MemoryDb;
  options: Pick<
    Parameters<typeof createMemory>[0],
    "embedder" | "now" | "supersessionDecider"
  >;
}

/** Bind the database, memory context, and optional test controls. */
export function memoryFixture(
  db: memories.MemoryDb,
  context: MemoryRuntimeContext,
  options: MemoryFixture["options"] = {},
): MemoryFixture {
  return { context, db, options };
}

/** Archive with the production access and validation rules. */
export async function archiveMemory(
  test: MemoryFixture,
  input: { id: string; reason?: string },
) {
  return await memories.archiveMemory({
    context: test.context,
    db: test.db,
    input,
    now: test.options.now,
  });
}

/** Create a memory about the Conversation. */
export async function createConversationMemory(
  test: MemoryFixture,
  input: CreateMemoryInput,
) {
  return await createMemory({
    context: test.context,
    db: test.db,
    ...test.options,
    input,
    subjectType: "conversation",
  });
}

/** Create a memory about the User. */
export async function createUserMemory(
  test: MemoryFixture,
  input: CreateMemoryInput,
) {
  return await createMemory({
    context: test.context,
    db: test.db,
    ...test.options,
    input,
    subjectType: "user",
  });
}

/** List active memories visible from a test runtime context. */
export async function listMemories(
  test: MemoryFixture,
  input: { limit?: number },
) {
  return await memories.listMemories({
    context: test.context,
    db: test.db,
    input,
    now: test.options.now,
  });
}

/** Retrieve candidates with automatic recall ranking rules. */
export async function recallMemories(
  test: MemoryFixture,
  input: RetrieveMemoriesInput,
) {
  return await retrieveMemories({
    context: test.context,
    db: test.db,
    embedder: test.options.embedder,
    input,
    mode: "recall",
    now: test.options.now,
  });
}

/** Retrieve candidates with explicit search ranking rules. */
export async function searchMemories(
  test: MemoryFixture,
  input: RetrieveMemoriesInput,
) {
  return await retrieveMemories({
    context: test.context,
    db: test.db,
    embedder: test.options.embedder,
    input,
    mode: "search",
    now: test.options.now,
  });
}
