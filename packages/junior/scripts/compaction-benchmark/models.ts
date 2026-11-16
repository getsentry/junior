import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { completeText, resolveGatewayModel } from "@/chat/pi/client";
import { estimateTextTokens } from "@/chat/services/token-estimate";

/** Model ids for the benchmark arms. */
export const MODELS = {
  opus: "anthropic/claude-opus-5.5",
  luna: "openai/gpt-6-luna",
} as const;

/** One cached text completion. */
export interface ModelCall {
  stage: string;
  modelId: string;
  system: string;
  user: string;
  maxTokens: number;
  /** Output size used for estimates and dry-run placeholders. */
  expectedOutputTokens: number;
}

/** Spend limits and cache location for one command. */
export interface Budget {
  cacheDir: string;
  maxUsd: number;
  dryRun: boolean;
}

/** Thrown before a call that would pass `--max-usd`. */
export class BudgetStop extends Error {}

const PER_MILLION = 1_000_000;

/** Catalog rates for a model at an input size, per #2029's tiered pricing. */
export function rates(modelId: string, inputTokens: number) {
  const model = resolveGatewayModel(modelId);
  return (
    model.cost.tiers
      ?.filter((tier) => inputTokens > tier.inputTokensAbove)
      .sort((a, b) => a.inputTokensAbove - b.inputTokensAbove)
      .at(-1) ?? model.cost
  );
}

/** Price an uncached call from catalog rates. */
export function estimateCallUsd(call: ModelCall): number {
  const inputTokens = estimateTextTokens(call.system + call.user);
  const rate = rates(call.modelId, inputTokens);
  return (
    (inputTokens * rate.input + call.expectedOutputTokens * rate.output) /
    PER_MILLION
  );
}

interface Ledger {
  spentUsd: number;
  calls: number;
  estimatedUsd: number;
  pendingCalls: number;
}

function ledgerPath(budget: Budget) {
  return join(budget.cacheDir, "ledger.json");
}

/** Read total recorded spend for this cache. */
export function readLedger(budget: Budget): Ledger {
  const path = ledgerPath(budget);
  const saved = existsSync(path)
    ? (JSON.parse(readFileSync(path, "utf8")) as Partial<Ledger>)
    : {};
  return {
    spentUsd: saved.spentUsd ?? 0,
    calls: saved.calls ?? 0,
    estimatedUsd: 0,
    pendingCalls: 0,
  };
}

function cachePath(budget: Budget, call: ModelCall) {
  const key = createHash("sha256")
    .update(
      JSON.stringify([call.modelId, call.system, call.user, call.maxTokens]),
    )
    .digest("hex");
  return join(budget.cacheDir, call.stage, `${key}.json`);
}

/**
 * Return a caller for one command. Cached results are free. A dry run adds
 * each uncached call's estimate and returns a placeholder of the expected
 * size, so later dependent calls can be estimated too.
 */
export function modelCaller(budget: Budget) {
  const ledger = readLedger(budget);
  // Concurrent calls reserve their estimate so the limit holds.
  let reservedUsd = 0;
  if (!budget.dryRun && !(budget.maxUsd > 0)) {
    throw new Error("Model stages need --max-usd. Run with --dry-run first.");
  }

  async function call(
    request: ModelCall,
  ): Promise<{ text: string; costUsd: number }> {
    const path = cachePath(budget, request);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as {
        text: string;
        costUsd: number;
      };
    }
    const estimate = estimateCallUsd(request);
    if (budget.dryRun) {
      ledger.estimatedUsd += estimate;
      ledger.pendingCalls += 1;
      return {
        text: "x ".repeat(request.expectedOutputTokens),
        costUsd: estimate,
      };
    }
    if (ledger.spentUsd + reservedUsd + estimate > budget.maxUsd) {
      throw new BudgetStop(
        `Stopping before ${request.stage}: spent $${ledger.spentUsd.toFixed(2)}, next call about $${estimate.toFixed(3)}, limit $${budget.maxUsd}.`,
      );
    }
    reservedUsd += estimate;
    const result = await completeText({
      modelId: request.modelId,
      system: request.system,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: request.user }],
          timestamp: Date.now(),
        },
      ],
      cacheRetention: "none",
      maxTokens: request.maxTokens,
      messageAttributeMode: "metadata",
      promptName: `compaction_benchmark.${request.stage}`,
    }).finally(() => {
      reservedUsd -= estimate;
    });
    const costUsd = result.message.usage?.cost?.total ?? estimate;
    const saved = { text: result.text, costUsd };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(saved));
    ledger.spentUsd += costUsd;
    ledger.calls += 1;
    writeFileSync(
      ledgerPath(budget),
      JSON.stringify({ spentUsd: ledger.spentUsd, calls: ledger.calls }),
    );
    return saved;
  }

  return { call, ledger };
}

/** Run independent calls with bounded concurrency, keeping input order. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = Array.from<R | undefined>({ length: items.length });
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results as R[];
}
