import { createWebSource } from "@sentry/junior-plugin-api";
import { githubPlugin } from "@sentry/junior-github";
import { createApp, defineJuniorPlugins } from "@/app";
import { turnBehavior } from "@/chat/conversations/kind-behavior";
import { renderCompactionSummary } from "@/chat/services/context-compaction";
import { estimateTextTokens } from "@/chat/services/token-estimate";
import { buildDeploymentSystemPrompt } from "@/chat/system-prompt";
import { createTools } from "@/chat/tools";
import type { AnyToolDefinition } from "@/chat/tools/definition";
import type { ToolRuntimeContext } from "@/chat/tools/types";
import type { ArmContext } from "./arms";
import {
  applicableRules,
  recordedActions,
  toActions,
  type Action,
  type RuleOutcome,
} from "./behavior-rules";
import type { BenchEvent } from "./events";
import {
  eventText,
  messagesBetween,
  type BenchMessage,
  type CompactionPoint,
} from "./history";
import { composeContext } from "./lore";
import {
  MODELS,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ChatToolCall,
  type ToolSpec,
} from "./models";
import { firstTurnAfter, type BenchTurn } from "./turns";

type Chat = (request: ChatRequest) => Promise<ChatResult>;

/** Model calls one replayed Turn may make before it counts as cut off. */
export const MAX_STEPS = 8;
/** Steps a dry run assumes per Turn, for pricing. */
const ESTIMATED_STEPS = 5;
const MESSAGE_CHARS = 30_000;
const RESULT_CHARS = 4_000;

/** Tool calls that end a root Turn. */
const TERMINAL = new Set(["noReply"]);

async function unavailable(): Promise<never> {
  throw new Error("The behavioral replay stubs every tool.");
}

/**
 * Junior's model-facing tools for a root web Conversation, built with the
 * production builder, as the Guardian evals do. Nothing executes them.
 */
export async function replayTools(): Promise<ToolSpec[]> {
  await createApp({ plugins: defineJuniorPlugins([githubPlugin()]) });
  const conversationId = "local:web:compaction-benchmark";
  // Nothing runs these tools, so no tool touches the sandbox or storage.
  const context: ToolRuntimeContext = {
    conversationId,
    conversationPrivacy: "private",
    destination: { platform: "local", conversationId },
    source: createWebSource(conversationId, "private"),
    egress: {
      async fetch() {
        return new Response("ok");
      },
    },
    attachmentStorage: {} as ToolRuntimeContext["attachmentStorage"],
    workspace: {} as ToolRuntimeContext["workspace"],
    messageAgent: unavailable,
    spawnAgent: unavailable,
    turnTools: turnBehavior({ kind: "root", personInput: true }).tools,
  };
  const tools = createTools([], {}, context) as Record<
    string,
    AnyToolDefinition
  >;
  return Object.entries(tools).map(([name, tool]) => ({
    type: "function",
    function: {
      name,
      description: tool.description,
      // TypeBox schemas are JSON Schema plus symbol keys; JSON drops those.
      parameters: JSON.parse(JSON.stringify(tool.inputSchema)) as unknown,
    },
  }));
}

/** The system prompt of a root Turn on the local web platform. */
export function replaySystemPrompt(): Promise<string> {
  return buildDeploymentSystemPrompt("local", "conversation");
}

function chatRole(message: BenchMessage): "user" | "assistant" {
  return message.role === "assistant" ? "assistant" : "user";
}

function chatText(message: BenchMessage): string {
  const text = message.text.slice(0, MESSAGE_CHARS);
  return message.role === "toolResult"
    ? `<tool-result>\n${text}\n</tool-result>`
    : text;
}

/**
 * Kept history as chat messages. Tool calls and results are rendered as
 * text, and neighbors with one role merge, so every provider accepts it.
 */
function historyMessages(messages: readonly BenchMessage[]): ChatMessage[] {
  const result: Array<{ role: "user" | "assistant"; text: string }> = [];
  for (const message of messages) {
    if (message.role === "summary") continue;
    const text = chatText(message).trim();
    if (!text) continue;
    const role = chatRole(message);
    const last = result.at(-1);
    if (last?.role === role) last.text = `${last.text}\n\n${text}`;
    else result.push({ role, text });
  }
  return result.map((entry) =>
    entry.role === "assistant"
      ? { role: "assistant", content: entry.text }
      : { role: "user", content: entry.text },
  );
}

/** What one replayed Turn needs: the point, its next real Turn and history. */
export interface ReplayCase {
  point: CompactionPoint;
  turn: BenchTurn;
  /** Kept tail plus the messages before the Turn started. */
  kept: BenchMessage[];
  /** The Turn's own input messages, before its first agent call. */
  input: BenchMessage[];
  real: Action[];
  /** Recorded results by tool name and arguments. */
  recorded: Map<string, string>;
}

function resultKey(name: string, args: unknown): string {
  return `${name}:${JSON.stringify(args)}`;
}

/** Build the replay case of each point that has a next Turn. */
export function replayCases(
  events: readonly BenchEvent[],
  points: readonly CompactionPoint[],
  turns: readonly BenchTurn[],
): ReplayCase[] {
  return points.flatMap((point) => {
    const turn = firstTurnAfter(turns, point.seq);
    if (!turn) return [];
    const firstCall = turn.callSeqs[0] ?? turn.endSeq + 1;
    const recorded = new Map<string, string>();
    const calls = new Map<string, string>();
    for (const event of events) {
      if (event.seq < turn.startSeq || event.seq > turn.endSeq) continue;
      const content = event.data.content;
      if (event.data.type === "assistant_message" && Array.isArray(content)) {
        for (const part of content as Array<Record<string, unknown>>) {
          if (part["type"] === "toolCall") {
            calls.set(
              String(part["id"]),
              resultKey(String(part["name"]), part["arguments"]),
            );
          }
        }
      }
      if (event.data.type === "tool_result") {
        const key = calls.get(String(event.data["toolCallId"]));
        const text = eventText(event.data);
        if (key && text) recorded.set(key, text.slice(0, RESULT_CHARS));
      }
    }
    return [
      {
        point,
        turn,
        kept: [
          ...point.tail,
          ...messagesBetween(events, point.seq, turn.startSeq),
        ],
        input: messagesBetween(events, turn.startSeq, firstCall).filter(
          (message) => message.role === "user",
        ),
        real: recordedActions(events, turn),
        recorded,
      },
    ];
  });
}

/** A canned result per tool, or the recorded result of the same call. */
function stubResult(replay: ReplayCase, call: ChatToolCall): string {
  let args: unknown;
  try {
    args = JSON.parse(call.function.arguments || "{}");
  } catch {
    args = call.function.arguments;
  }
  const recorded = replay.recorded.get(resultKey(call.function.name, args));
  if (recorded) return recorded;
  switch (call.function.name) {
    case "bash":
      return JSON.stringify({ exit_code: 0, stdout: "", stderr: "" });
    case "readFile":
      return JSON.stringify({
        error: "File contents are not available in this replay.",
      });
    case "addReviewItem":
      return JSON.stringify({ id: "replay-review-item", status: "open" });
    case "spawnAgent":
    case "messageAgent":
      return JSON.stringify({ status: "queued" });
    default:
      return JSON.stringify({ ok: true });
  }
}

/** One replayed Turn of one arm, and its rule outcomes. */
export interface BehaviorResult {
  arm: string;
  point: number;
  /** `completed`: the Turn ended. `step_cap`: it was still calling tools. */
  ending: "completed" | "step_cap";
  actions: Action[];
  outcomes: Record<string, RuleOutcome>;
  costUsd: number;
}

/**
 * Replay the real next Turn with one arm's context in place of removed
 * history, stub every tool, and score the applicable rules. A cut-off Turn
 * cannot pass a "never X" rule.
 */
export async function replayTurn(args: {
  arm: string;
  entry: ArmContext | undefined;
  replay: ReplayCase;
  standing: ReadonlyMap<string, number>;
  system: string;
  tools: ToolSpec[];
  chat: Chat;
}): Promise<BehaviorResult> {
  const rules = applicableRules({
    point: args.replay.point.index,
    standing: args.standing,
    turn: args.replay.turn,
    real: args.replay.real,
  });
  const context = args.entry
    ? composeContext(args.entry, args.replay.turn.input)
    : "";
  const input = args.replay.input.map((message) => message.text).join("\n\n");
  const base: ChatMessage[] = [
    {
      role: "system",
      content: [
        {
          type: "text",
          text: args.system,
          cache_control: { type: "ephemeral" },
        },
      ],
    },
    ...(context
      ? [{ role: "user" as const, content: renderCompactionSummary(context) }]
      : []),
    ...historyMessages(args.replay.kept),
    {
      role: "user",
      content: [
        { type: "text", text: input, cache_control: { type: "ephemeral" } },
      ],
    },
  ];
  const fixedTokens = estimateTextTokens(
    args.system + JSON.stringify(args.tools),
  );
  const baseTokens = estimateTextTokens(
    JSON.stringify(base) + JSON.stringify(args.tools),
  );
  const messages = [...base];
  const actions: Action[] = [];
  let cost = 0;
  let ending: BehaviorResult["ending"] = "step_cap";
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const result = await args.chat({
      stage: `behavior-${args.arm}`,
      modelId: MODELS.opus,
      messages,
      tools: args.tools,
      maxTokens: 4_000,
      expectedOutputTokens: 600,
      cachedPrefixTokens: step === 0 ? fixedTokens : baseTokens,
    });
    cost += result.costUsd;
    if (result.placeholder) {
      // Price the expected Turn length: each step adds a call and a result.
      if (step + 1 >= ESTIMATED_STEPS) break;
      messages.push({ role: "assistant", content: "x ".repeat(600) });
      messages.push({ role: "user", content: "x ".repeat(300) });
      continue;
    }
    const reply: ChatMessage = {
      role: "assistant",
      content: result.text || null,
    };
    if (result.toolCalls.length) reply.tool_calls = result.toolCalls;
    messages.push(reply);
    if (!result.toolCalls.length) {
      ending = "completed";
      break;
    }
    let ended = false;
    for (const call of result.toolCalls) {
      let parsed: unknown = {};
      try {
        parsed = JSON.parse(call.function.arguments || "{}");
      } catch {
        parsed = { raw: call.function.arguments };
      }
      actions.push(...toActions(call.function.name, parsed, step));
      if (TERMINAL.has(call.function.name)) ended = true;
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: stubResult(args.replay, call),
      });
    }
    if (ended) {
      ending = "completed";
      break;
    }
  }
  const outcomes: Record<string, RuleOutcome> = {};
  for (const rule of rules) {
    const outcome = rule.check(actions);
    outcomes[rule.id] =
      outcome === "pass" && rule.negative && ending !== "completed"
        ? "inconclusive"
        : outcome;
  }
  return {
    arm: args.arm,
    point: args.replay.point.index,
    ending,
    actions,
    outcomes,
    costUsd: cost,
  };
}
