import { createMemory, type CreateMemoryInput } from "../src/create";
import type { MemoryDb } from "../src/memories";
import { retrieveMemories } from "../src/retrieval";
import type { MemoryRuntimeContext } from "../src/types";

type RetrieveMemoriesInput = Parameters<typeof retrieveMemories>[0]["input"];

interface MemoryFixture {
  context: MemoryRuntimeContext;
  db: MemoryDb;
  options: Pick<
    Parameters<typeof createMemory>[0],
    "embedder" | "now" | "supersessionDecider"
  >;
}

/** Bind the database, memory context, and optional test controls. */
export function memoryFixture(
  db: MemoryDb,
  context: MemoryRuntimeContext,
  options: MemoryFixture["options"] = {},
): MemoryFixture {
  return { context, db, options };
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
