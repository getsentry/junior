/**
 * Shared parts of the derived embedding indexes. Each owner keeps its own
 * table, so a foreign key still deletes a vector with its source row. These
 * helpers keep the column types, the distance SQL, the batch checks, and the
 * backfill loop the same in every table.
 */
import { sql, type SQL } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";
import * as z from "zod";
import type {
  PluginEmbedder,
  PluginEmbeddingInputType,
} from "@sentry/junior-plugin-api";

type PgvectorType = "vector" | "halfvec";

function pgvectorColumn(dataType: PgvectorType) {
  return customType<{ data: number[]; driverData: string }>({
    dataType() {
      return dataType;
    },
    toDriver(value) {
      return JSON.stringify(value);
    },
    fromDriver(value) {
      return value.slice(1, -1).split(",").map(Number);
    },
  });
}

/**
 * pgvector `vector` column without a fixed size, so a new embedding model
 * needs no migration. Each table records the size of each row in its own
 * column.
 */
export const embeddingVector = pgvectorColumn("vector");

/**
 * Half-precision `embeddingVector`: 2 bytes per value instead of 4, for
 * tables that hold many vectors.
 */
export const embeddingHalfvec = pgvectorColumn("halfvec");

/** One embedding vector and the model that made it. */
export interface EmbeddingVector {
  model: string;
  provider: string;
  vector: number[];
}

/** Vectors of one embedder call, all of one size. */
export interface EmbeddingBatch {
  dimensions: number;
  model: string;
  provider: string;
  vectors: number[][];
}

const embeddingResultSchema = z
  .object({
    costUsd: z.number().finite().nonnegative().optional(),
    dimensions: z.number().int().positive(),
    model: z.string().min(1),
    provider: z.string().min(1),
    vectors: z.array(z.array(z.number().finite())),
  })
  .strict();

/**
 * Validate an embedder result: one vector per text, all of the reported
 * size. With `dimensions`, the size must be one that the table accepts. With
 * `expected`, the result must come from that provider and model, because a
 * backfill that finds rows by model would see a row of another model as
 * missing on every run.
 */
export function parseEmbeddingBatch(
  raw: unknown,
  args: {
    dimensions?: readonly number[];
    expected?: { model: string; provider: string };
    textCount: number;
  },
): EmbeddingBatch {
  const result = embeddingResultSchema.parse(raw);
  if (args.dimensions && !args.dimensions.includes(result.dimensions)) {
    throw new Error("Unsupported embedding vector size.");
  }
  if (result.vectors.length !== args.textCount) {
    throw new Error("Embedding provider returned an unexpected vector count.");
  }
  if (result.vectors.some((vector) => vector.length !== result.dimensions)) {
    throw new Error("Embedding provider returned an unexpected vector size.");
  }
  if (
    args.expected &&
    (result.provider !== args.expected.provider ||
      result.model !== args.expected.model)
  ) {
    throw new Error(
      `Embedding provider used model ${result.provider}/${result.model}, not ${args.expected.provider}/${args.expected.model}.`,
    );
  }
  return {
    dimensions: result.dimensions,
    model: result.model,
    provider: result.provider,
    vectors: result.vectors,
  };
}

/** Embed one text with the embedder's model and return its vector. */
export async function embedText(
  embedder: PluginEmbedder,
  input: { inputType: PluginEmbeddingInputType; text: string },
): Promise<EmbeddingVector> {
  const batch = parseEmbeddingBatch(
    await embedder.embedTexts({
      inputType: input.inputType,
      texts: [input.text],
    }),
    { expected: embedder, textCount: 1 },
  );
  return {
    model: batch.model,
    provider: batch.provider,
    vector: batch.vectors[0]!,
  };
}

// A literal, not a bind parameter, so Postgres can match a partial index
// on the size.
function vectorSize(query: readonly number[]): SQL {
  if (query.length === 0) {
    throw new Error("Embedding vector is empty.");
  }
  return sql.raw(String(query.length));
}

/**
 * Cosine distance from a stored vector to a query vector. Both sides are cast
 * to the query size, the form that an HNSW expression index on that size
 * matches. The cast fails on a stored vector of another size, so filter on the
 * size first, as the index predicate does, or use `guardedCosineDistance`.
 * A caller with another copy of drizzle-orm embeds the result in its own
 * `sql` template to get its own `SQL` type.
 */
export function cosineDistance(args: {
  /**
   * Vector column of the caller's table. Not typed as a drizzle column: a
   * plugin can load another copy of drizzle-orm, whose column types do not
   * match this copy. Drizzle finds columns of any copy at run time.
   */
  column: unknown;
  query: readonly number[];
  type: PgvectorType;
}): SQL<number> {
  const size = vectorSize(args.query);
  const type = sql.raw(args.type);
  return sql<number>`(${args.column}::${type}(${size})) <=> ${JSON.stringify(args.query)}::${type}(${size})`;
}

/**
 * `cosineDistance`, or null for a stored vector of another size. Postgres
 * does not promise to check a WHERE term before it computes an ORDER BY or
 * SELECT expression, and pgvector fails on vectors of two sizes. CASE fixes
 * the order.
 */
export function guardedCosineDistance(args: {
  /** Vector column, as in `cosineDistance`. */
  column: unknown;
  /** Column that stores the size of each vector. */
  dimensions: unknown;
  query: readonly number[];
  type: PgvectorType;
}): SQL<number | null> {
  return sql<
    number | null
  >`CASE WHEN ${args.dimensions} = ${vectorSize(args.query)} THEN ${cosineDistance(args)} END`;
}

/** Outcome of one `refreshEmbeddings` run. */
export interface EmbeddingRefresh {
  /** No missing item was left. False when the deadline or `maxItems` stopped the run. */
  done: boolean;
  embedded: number;
}

/**
 * Embed items that have no current vector, one batch at a time, and store
 * each batch before the next starts. `listMissing` returns the next items in
 * the caller's order, after the last item of the previous page, so each run
 * ends even when a write leaves an item missing. Text that trims to nothing
 * is skipped, because the embedder rejects it. A provider failure stops the
 * run and keeps the batches stored before it, so a later run continues.
 */
export async function refreshEmbeddings<TItem extends { text: string }>(args: {
  batchSize: number;
  /** Do not start a batch at or after this time. */
  deadlineMs?: number | undefined;
  /** Vector sizes that the table accepts. */
  dimensions?: readonly number[];
  embedder: PluginEmbedder;
  listMissing(page: {
    after: TItem | undefined;
    limit: number;
  }): Promise<TItem[]>;
  /** Most items to embed in one run. */
  maxItems?: number;
  now?: () => number;
  write(
    rows: Array<{ item: TItem; vector: number[] }>,
    batch: EmbeddingBatch,
  ): Promise<void>;
}): Promise<EmbeddingRefresh> {
  const now = args.now ?? Date.now;
  let after: TItem | undefined;
  let embedded = 0;
  for (;;) {
    const remaining = (args.maxItems ?? Infinity) - embedded;
    if (
      remaining <= 0 ||
      (args.deadlineMs !== undefined && now() >= args.deadlineMs)
    ) {
      return { done: false, embedded };
    }
    // oxlint-disable-next-line no-await-in-loop -- each page starts after the last item of the page before it.
    const page = await args.listMissing({
      after,
      limit: Math.min(args.batchSize, remaining),
    });
    after = page.at(-1);
    if (!after) {
      return { done: true, embedded };
    }
    const items = page.filter((item) => item.text.trim() !== "");
    if (items.length === 0) {
      continue;
    }
    const batch = parseEmbeddingBatch(
      // oxlint-disable-next-line no-await-in-loop -- one batch at a time, so a provider failure keeps the batches stored before it.
      await args.embedder.embedTexts({
        inputType: "document",
        texts: items.map((item) => item.text),
      }),
      {
        ...(args.dimensions ? { dimensions: args.dimensions } : undefined),
        expected: args.embedder,
        textCount: items.length,
      },
    );
    // oxlint-disable-next-line no-await-in-loop -- stores the batch embedded above before the next batch starts.
    await args.write(
      items.map((item, index) => ({ item, vector: batch.vectors[index]! })),
      batch,
    );
    embedded += items.length;
  }
}
