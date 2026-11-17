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
  /** Dry-run estimates by stage family, such as `probe` or `summary`. */
  estimatedByStage: Record<string, { calls: number; usd: number }>;
}

function stageFamily(stage: string): string {
  return stage.startsWith("probe-") ? "probe" : stage;
}

function addEstimate(ledger: Ledger, stage: string, usd: number) {
  ledger.estimatedUsd += usd;
  ledger.pendingCalls += 1;
  const row = (ledger.estimatedByStage[stageFamily(stage)] ??= {
    calls: 0,
    usd: 0,
  });
  row.calls += 1;
  row.usd += usd;
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
    estimatedByStage: {},
  };
}

function cachePath(budget: Budget, call: ModelCall) {
  const key = createHash("sha256")
    .update(
      JSON.stringify([
        provider(),
        call.modelId,
        call.system,
        call.user,
        call.maxTokens,
      ]),
    )
    .digest("hex");
  return join(budget.cacheDir, call.stage, `${key}.json`);
}

/**
 * OpenRouter when `OPENROUTER_API_KEY` is set, else AI Gateway. A dry run
 * can set `COMPACTION_BENCHMARK_PROVIDER` to price against that provider's
 * cache without a key.
 */
export function provider(): "openrouter" | "gateway" {
  const forced = process.env["COMPACTION_BENCHMARK_PROVIDER"];
  if (forced === "openrouter" || forced === "gateway") return forced;
  return process.env["OPENROUTER_API_KEY"] ? "openrouter" : "gateway";
}

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

async function gatewayComplete(request: ModelCall, estimate: number) {
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
  });
  return {
    text: result.text,
    costUsd: result.message.usage?.cost?.total ?? estimate,
  };
}

interface OpenRouterResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    cost?: number;
    cost_details?: { upstream_inference_cost?: number };
  };
}

/**
 * Call OpenRouter's OpenAI-compatible endpoint with the same model ids.
 * OpenRouter can report a zero cost (for example on keys with upstream
 * billing), so charge the highest of its cost, its upstream cost, and catalog
 * rates on its token counts, and the pre-call estimate when all are zero.
 * This keeps `--max-usd` a real cap.
 */
async function openRouterComplete(request: ModelCall, estimate: number) {
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${process.env["OPENROUTER_API_KEY"]}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: request.modelId,
        messages: [
          { role: "system", content: request.system },
          { role: "user", content: request.user },
        ],
        max_tokens: request.maxTokens,
        usage: { include: true },
      }),
    });
    // Rate limits and provider outages are transient; retry them twice.
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) =>
        setTimeout(resolve, 5_000 * (attempt + 1)),
      );
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `OpenRouter ${response.status} for ${request.modelId}: ${(await response.text()).slice(0, 300)}`,
      );
    }
    const body = (await response.json()) as OpenRouterResponse;
    const input = body.usage?.prompt_tokens ?? 0;
    const output = body.usage?.completion_tokens ?? 0;
    const rate = rates(request.modelId, input);
    const costUsd = Math.max(
      body.usage?.cost ?? 0,
      body.usage?.cost_details?.upstream_inference_cost ?? 0,
      (input * rate.input + output * rate.output) / PER_MILLION,
    );
    return {
      text: body.choices?.[0]?.message?.content ?? "",
      costUsd: costUsd > 0 ? costUsd : estimate,
      usage: body.usage ?? null,
    };
  }
}

/** One OpenAI-format chat message, as OpenRouter and AI Gateway accept. */
export type ChatMessage =
  | {
      role: "system" | "user";
      content:
        | string
        | Array<{
            type: "text";
            text: string;
            cache_control?: { type: "ephemeral" };
          }>;
    }
  | { role: "assistant"; content: string | null; tool_calls?: ChatToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolSpec {
  type: "function";
  function: { name: string; description: string; parameters: unknown };
}

/** One tool-using model call of a replayed Turn. */
export interface ChatRequest {
  stage: string;
  modelId: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  maxTokens: number;
  expectedOutputTokens: number;
  /** Prompt tokens that an earlier call of the same Turn already cached. */
  cachedPrefixTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ChatToolCall[];
  finishReason: string;
  costUsd: number;
  /** Set on dry-run placeholders, which hold no real reply. */
  placeholder?: true;
}

const GATEWAY_CHAT_URL = "https://ai-gateway.vercel.sh/v1/chat/completions";

/** Price a chat call from catalog rates, counting the cached prefix as reads. */
export function estimateChatUsd(request: ChatRequest): number {
  const input = estimateTextTokens(
    JSON.stringify(request.messages) + JSON.stringify(request.tools),
  );
  const cached = Math.min(request.cachedPrefixTokens, input);
  const rate = rates(request.modelId, input);
  return (
    (cached * rate.cacheRead +
      (input - cached) * rate.cacheWrite +
      request.expectedOutputTokens * rate.output) /
    PER_MILLION
  );
}

interface ChatResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; tool_calls?: ChatToolCall[] };
  }>;
  usage?: OpenRouterResponse["usage"] & {
    prompt_tokens_details?: {
      cached_tokens?: number;
      cache_write_tokens?: number;
    };
  };
}

/**
 * Send one tool-using call through the OpenAI-compatible endpoint of the
 * active provider. Charge the highest of the reported cost and catalog
 * rates on the reported tokens, as `openRouterComplete` does.
 */
async function chatComplete(
  request: ChatRequest,
  estimate: number,
): Promise<ChatResult> {
  const openRouter = provider() === "openrouter";
  const key = openRouter
    ? process.env["OPENROUTER_API_KEY"]
    : process.env["AI_GATEWAY_API_KEY"];
  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(
      openRouter ? OPENROUTER_URL : GATEWAY_CHAT_URL,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: request.modelId,
          messages: request.messages,
          tools: request.tools,
          max_tokens: request.maxTokens,
          usage: { include: true },
        }),
      },
    );
    // Rate limits and provider outages are transient; retry them twice.
    if ((response.status === 429 || response.status >= 500) && attempt < 2) {
      await new Promise((resolve) =>
        setTimeout(resolve, 5_000 * (attempt + 1)),
      );
      continue;
    }
    if (!response.ok) {
      throw new Error(
        `Chat ${response.status} for ${request.modelId}: ${(await response.text()).slice(0, 300)}`,
      );
    }
    const body = (await response.json()) as ChatResponse;
    const usage = body.usage;
    const prompt = usage?.prompt_tokens ?? 0;
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const written = usage?.prompt_tokens_details?.cache_write_tokens ?? 0;
    const rate = rates(request.modelId, prompt);
    const tokenUsd =
      (cached * rate.cacheRead +
        written * rate.cacheWrite +
        Math.max(0, prompt - cached - written) * rate.input +
        (usage?.completion_tokens ?? 0) * rate.output) /
      PER_MILLION;
    const costUsd = Math.max(
      usage?.cost ?? 0,
      usage?.cost_details?.upstream_inference_cost ?? 0,
      tokenUsd,
    );
    const choice = body.choices?.[0];
    return {
      text: choice?.message?.content ?? "",
      toolCalls: choice?.message?.tool_calls ?? [],
      finishReason: choice?.finish_reason ?? "unknown",
      costUsd: costUsd > 0 ? costUsd : estimate,
    };
  }
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
  if (
    !budget.dryRun &&
    provider() === "openrouter" &&
    !process.env["OPENROUTER_API_KEY"]
  ) {
    throw new Error("The OpenRouter provider needs OPENROUTER_API_KEY.");
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
      addEstimate(ledger, request.stage, estimate);
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
    const saved = await (
      provider() === "openrouter"
        ? openRouterComplete(request, estimate)
        : gatewayComplete(request, estimate)
    ).finally(() => {
      reservedUsd -= estimate;
    });
    const costUsd = saved.costUsd;
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

  /** Cached, budgeted tool-using call. Dry runs return a placeholder. */
  async function chat(request: ChatRequest): Promise<ChatResult> {
    const key = createHash("sha256")
      .update(
        JSON.stringify([
          provider(),
          request.modelId,
          request.messages,
          request.tools,
          request.maxTokens,
        ]),
      )
      .digest("hex");
    const path = join(budget.cacheDir, request.stage, `${key}.json`);
    if (existsSync(path)) {
      return JSON.parse(readFileSync(path, "utf8")) as ChatResult;
    }
    const estimate = estimateChatUsd(request);
    if (budget.dryRun) {
      addEstimate(ledger, request.stage, estimate);
      return {
        text: "",
        toolCalls: [],
        finishReason: "dry_run",
        costUsd: estimate,
        placeholder: true,
      };
    }
    if (ledger.spentUsd + reservedUsd + estimate > budget.maxUsd) {
      throw new BudgetStop(
        `Stopping before ${request.stage}: spent $${ledger.spentUsd.toFixed(2)}, next call about $${estimate.toFixed(3)}, limit $${budget.maxUsd}.`,
      );
    }
    reservedUsd += estimate;
    const saved = await chatComplete(request, estimate).finally(() => {
      reservedUsd -= estimate;
    });
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(saved));
    ledger.spentUsd += saved.costUsd;
    ledger.calls += 1;
    writeFileSync(
      ledgerPath(budget),
      JSON.stringify({ spentUsd: ledger.spentUsd, calls: ledger.calls }),
    );
    return saved;
  }

  return { call, chat, ledger };
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
