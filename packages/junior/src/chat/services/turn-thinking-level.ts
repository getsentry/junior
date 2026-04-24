import type { ThinkingLevel as AgentThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ThinkingLevel as ProviderThinkingLevel } from "@mariozechner/pi-ai";
import { z } from "zod";

const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.75;
const MAX_ROUTER_CONTEXT_CHARS = 1_200;
const TURN_THINKING_LEVELS = ["none", "low", "medium", "high"] as const;

const turnExecutionProfileSchema = z.object({
  thinking_level: z.enum(TURN_THINKING_LEVELS),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

type TurnThinkingLevel = (typeof TURN_THINKING_LEVELS)[number];

export interface TurnThinkingSelection {
  confidence?: number;
  thinkingLevel: TurnThinkingLevel;
  reason: string;
}

const DEFAULT_THINKING_LEVEL: TurnThinkingSelection["thinkingLevel"] = "low";

function trimContextForRouter(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= MAX_ROUTER_CONTEXT_CHARS
    ? trimmed
    : trimmed.slice(-MAX_ROUTER_CONTEXT_CHARS);
}

function buildClassifierSystemPrompt(): string {
  return [
    "You route assistant turns to the cheapest thinking level that is still likely to succeed.",
    "Choose exactly one bucket: none, low, medium, or high.",
    "",
    "Use none for greetings, acknowledgments, and trivial single-step asks.",
    "Use low for straightforward explanations or simple one-step work.",
    "Use medium for investigations, ambiguous asks, multi-step analysis, or likely multi-tool work.",
    "Use high for code changes, debugging/root-cause analysis, research-heavy work, non-trivial drafting, or explicit requests to be thorough.",
    "",
    "Return JSON only with thinking_level, confidence, and reason.",
  ].join("\n");
}

function buildClassifierPrompt(args: {
  conversationContext?: string;
  currentTurnBlocks?: string[];
  messageText: string;
}): string {
  const sections: string[] = [];

  const context = trimContextForRouter(args.conversationContext);
  if (context) {
    sections.push("<thread-background>", context, "</thread-background>", "");
  }

  sections.push(
    "<current-instruction>",
    args.messageText.trim() || "[empty]",
    "</current-instruction>",
  );

  for (const block of args.currentTurnBlocks ?? []) {
    const trimmed = block.trim();
    if (!trimmed) {
      continue;
    }
    sections.push("", trimmed);
  }

  return sections.join("\n");
}

/** Choose the thinking level for the upcoming assistant turn. */
export async function selectTurnThinkingLevel(args: {
  completeObject: (args: {
    modelId: string;
    schema: typeof turnExecutionProfileSchema;
    maxTokens: number;
    metadata: Record<string, string>;
    prompt: string;
    thinkingLevel?: ProviderThinkingLevel;
    system: string;
    temperature: number;
  }) => Promise<{ object: unknown }>;
  conversationContext?: string;
  context?: {
    channelId?: string;
    requesterId?: string;
    runId?: string;
    threadId?: string;
  };
  currentTurnBlocks?: string[];
  fastModelId: string;
  messageText: string;
}): Promise<TurnThinkingSelection> {
  try {
    const result = await args.completeObject({
      modelId: args.fastModelId,
      schema: turnExecutionProfileSchema,
      maxTokens: 120,
      metadata: {
        modelId: args.fastModelId,
        threadId: args.context?.threadId ?? "",
        channelId: args.context?.channelId ?? "",
        requesterId: args.context?.requesterId ?? "",
        runId: args.context?.runId ?? "",
      },
      prompt: buildClassifierPrompt({
        conversationContext: args.conversationContext,
        currentTurnBlocks: args.currentTurnBlocks,
        messageText: args.messageText,
      }),
      thinkingLevel: "low",
      system: buildClassifierSystemPrompt(),
      temperature: 0,
    });

    const parsed = turnExecutionProfileSchema.parse(result.object);
    if (parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
      return {
        confidence: parsed.confidence,
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        reason: `low_confidence_default:${parsed.reason.trim()}`,
      };
    }

    return {
      confidence: parsed.confidence,
      thinkingLevel: parsed.thinking_level,
      reason: parsed.reason.trim(),
    };
  } catch {
    return {
      thinkingLevel: DEFAULT_THINKING_LEVEL,
      reason: "classifier_error_default",
    };
  }
}

/** Convert a routing bucket into the Pi Agent thinking level for a main turn. */
export function toAgentThinkingLevel(
  level: TurnThinkingSelection["thinkingLevel"],
): AgentThinkingLevel | "off" {
  switch (level) {
    case "none":
      return "off";
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
  }
}
