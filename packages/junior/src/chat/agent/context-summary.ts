/**
 * Context summary for capacity compaction.
 *
 * The summary request is the agent model request for the same messages, with
 * one more user message that asks for the summary. The model, system prompt,
 * tools, and reasoning stay the same, so the provider can read the cached
 * prompt prefix of the last agent call. Anthropic drops cached messages when
 * `tool_choice`, thinking, or effort change, so the request keeps the tools
 * and the instruction forbids tool calls instead.
 */
import type { Agent, StreamFn } from "@earendil-works/pi-agent-core";
import type {
  Api,
  AssistantMessage,
  Context,
  Message,
  Model,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { extractGenAiUsageSummary, logWarn } from "@/chat/logging";
import type { PiMessage } from "@/chat/pi/messages";
import { createProviderError } from "@/chat/services/provider-error";
import { agentTurnCostUsd } from "@/chat/usage";

/** Prompt name of the summary request on its `gen_ai.chat` span. */
export const CONTEXT_COMPACTION_PROMPT_NAME = "junior.context_compaction";

// Thinking counts against this limit. The instruction asks for much less, so
// a stop at this limit means that the output is not a usable summary.
const SUMMARY_MAX_TOKENS = 8_000;

const SUMMARY_INSTRUCTION = `Stop work on the task now. Do not call tools. Write a summary of the conversation so far. The summary replaces the earlier history, and you will continue the work from the summary alone.

Return only the summary inside <summary></summary> tags. Use these sections in this order. Write each item as one short line that starts with "- ". Write "- None" for an empty section.

## Goal
## Constraints & preferences
## Progress
### Done
### In progress
### Blocked
## Key decisions
## Open asks
User requests that are not complete yet, quoted in the user's exact words.
## References
Exact file paths, IDs, URLs, commands, and error text that the work needs. At most 20 items.
## Next steps

Rules:
- Keep the summary under 1,000 words.
- Leave out the system prompt, AGENTS.md instructions, tool descriptions, and environment details. They are added again.
- Do not mention this request or the summary itself.
- If the history contains an earlier summary, update it. Keep the items that are still true, move finished work to Done, and remove stale items. When the earlier summary and newer history disagree, use the newer history.`;

const SUMMARY_NUDGE =
  "Do not call tools. Keep the summary short. Return only the summary inside <summary></summary> tags.";

/** Arguments of one agent model request, in `StreamFn` order. */
export interface AgentModelRequest {
  model: Model<Api>;
  context: Context;
  options: SimpleStreamOptions;
}

type SummaryFailure = "empty" | "max_tokens" | "missing_summary" | "tool_call";

/** A context summary and the estimated cost of the requests that made it. */
export interface ContextSummary {
  summary: string;
  costUsd?: number;
}

/** Raised when the model returns no usable summary after one nudge. */
export class ContextSummaryError extends Error {
  readonly failure: SummaryFailure;
  /** Estimated cost of the summary requests that did not succeed. */
  readonly costUsd?: number;

  constructor(failure: SummaryFailure, costUsd?: number) {
    super(`Context summary failed: ${failure}`);
    this.failure = failure;
    this.name = "ContextSummaryError";
    if (costUsd !== undefined) this.costUsd = costUsd;
  }
}

/**
 * Build the model request that the agent loop sends for these messages.
 *
 * This repeats the steps of pi-agent-core before each model call
 * (`streamAssistantResponse` and `createLoopConfig`, which Pi does not
 * export): transform and convert the messages, then read the model,
 * reasoning, tools, and request options from the agent. A unit test compares
 * this request with the one that a real Pi `Agent` loop passes to `streamFn`,
 * so it fails when Pi changes these steps.
 */
export async function buildAgentModelRequest(
  agent: Agent,
  messages: PiMessage[],
  signal?: AbortSignal,
): Promise<AgentModelRequest> {
  const { model, systemPrompt, thinkingLevel, tools } = agent.state;
  const transformed = agent.transformContext
    ? await agent.transformContext(messages, signal)
    : messages;
  return {
    model,
    context: {
      systemPrompt,
      messages: await agent.convertToLlm(transformed),
      tools,
    },
    options: {
      reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
      sessionId: agent.sessionId,
      onPayload: agent.onPayload,
      onResponse: agent.onResponse,
      transport: agent.transport,
      thinkingBudgets: agent.thinkingBudgets,
      maxRetryDelayMs: agent.maxRetryDelayMs,
      apiKey: (await agent.getApiKey?.(model.provider)) || undefined,
      signal,
    },
  };
}

function userText(text: string): Message {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

async function complete(
  request: AgentModelRequest,
  streamFn: StreamFn,
  appended: Message[],
): Promise<AssistantMessage> {
  const stream = await streamFn(
    request.model,
    {
      ...request.context,
      messages: [...request.context.messages, ...appended],
    },
    { ...request.options, maxTokens: SUMMARY_MAX_TOKENS },
  );
  const message = await stream.result();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    throw createProviderError(message.errorMessage ?? message.stopReason, {
      modelId: request.model.id,
    });
  }
  return message;
}

/** Read the summary, or name why the output is not a usable summary. */
function readSummary(
  message: AssistantMessage,
): { summary: string } | { failure: SummaryFailure } {
  if (message.content.some((part) => part.type === "toolCall")) {
    return { failure: "tool_call" };
  }
  // A cut-off summary can miss its last sections. Never store one.
  if (message.stopReason === "length") {
    return { failure: "max_tokens" };
  }
  const text = message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
  if (!text) {
    return { failure: "empty" };
  }
  const summary = /<summary>([\s\S]*?)<\/summary>/.exec(text)?.[1]?.trim();
  return summary ? { summary } : { failure: "missing_summary" };
}

/**
 * Ask the agent model for a summary of the request messages.
 *
 * A tool call, a stop at the output limit, empty output, or output without
 * `<summary>` tags gets one nudge. A second failure throws
 * `ContextSummaryError`, so the caller keeps the full history. The cost
 * covers each summary request, including a nudged one.
 */
export async function requestContextSummary(
  request: AgentModelRequest,
  streamFn: StreamFn,
): Promise<ContextSummary> {
  const instruction = userText(SUMMARY_INSTRUCTION);
  const firstMessage = await complete(request, streamFn, [instruction]);
  const first = readSummary(firstMessage);
  if ("summary" in first) {
    return withCost(first.summary, firstMessage);
  }
  logWarn("context_compaction.summary.nudged", {
    "app.compaction.summary_failure": first.failure,
  });
  const secondMessage = await complete(request, streamFn, [
    instruction,
    userText(SUMMARY_NUDGE),
  ]);
  const second = readSummary(secondMessage);
  if ("summary" in second) {
    return withCost(second.summary, firstMessage, secondMessage);
  }
  throw new ContextSummaryError(
    second.failure,
    summaryCostUsd(firstMessage, secondMessage),
  );
}

function summaryCostUsd(...messages: AssistantMessage[]): number | undefined {
  return agentTurnCostUsd(extractGenAiUsageSummary(...messages));
}

function withCost(
  summary: string,
  ...messages: AssistantMessage[]
): ContextSummary {
  const costUsd = summaryCostUsd(...messages);
  return costUsd === undefined ? { summary } : { summary, costUsd };
}
