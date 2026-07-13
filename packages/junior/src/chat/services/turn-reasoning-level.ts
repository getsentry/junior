import type { ThinkingLevel as AgentThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel as ProviderThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import {
  TURN_REASONING_LEVELS,
  type TurnReasoningLevel,
} from "@/chat/reasoning-level";
import { renderCurrentInstruction } from "@/chat/current-instruction";
import { setSpanAttributes, withSpan, type LogContext } from "@/chat/logging";

const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.75;
const MAX_ROUTER_CONTEXT_CHARS = 8_000;
const ROUTER_CONTEXT_HEAD_CHARS = 3_000;
const ROUTER_CONTEXT_TAIL_CHARS = 5_000;
const TRUNCATION_MARKER = "\n…[truncated]…\n";
const CONFIDENCE_LABELS: Record<string, number> = {
  low: 0.5,
  medium: CLASSIFIER_CONFIDENCE_THRESHOLD,
  high: 0.9,
};

function coerceClassifierConfidence(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return value;
  }

  const numeric = Number.parseFloat(trimmed);
  if (Number.isFinite(numeric)) {
    return numeric;
  }

  return CONFIDENCE_LABELS[trimmed] ?? value;
}

const turnExecutionProfileSchema = z.object({
  reasoning_level: z.enum(TURN_REASONING_LEVELS),
  confidence: z.preprocess(
    coerceClassifierConfidence,
    z.number().min(0).max(1),
  ),
  reason: z.string().min(1),
});

export interface TurnReasoningSelection {
  confidence?: number;
  reasoningLevel: TurnReasoningLevel;
  reason: string;
}

const CLASSIFIER_FALLBACK_REASONING_LEVEL: TurnReasoningSelection["reasoningLevel"] =
  "medium";
const REASONING_LEVEL_RANK: Record<TurnReasoningLevel, number> = {
  none: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
};

interface TrimmedContext {
  text: string;
  truncated: boolean;
  originalCharCount: number;
}

function trimContextForRouter(text: string | undefined): TrimmedContext | null {
  const trimmed = text?.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.length <= MAX_ROUTER_CONTEXT_CHARS) {
    return {
      text: trimmed,
      truncated: false,
      originalCharCount: trimmed.length,
    };
  }
  // Keep both ends of the thread: head preserves the original task framing,
  // tail preserves the most recent turn. Short follow-ups like "go" are often
  // preceded by the bot's clarifying question, so tail alone is misleading.
  const head = trimmed.slice(0, ROUTER_CONTEXT_HEAD_CHARS).trimEnd();
  const tail = trimmed.slice(-ROUTER_CONTEXT_TAIL_CHARS).trimStart();
  return {
    text: `${head}${TRUNCATION_MARKER}${tail}`,
    truncated: true,
    originalCharCount: trimmed.length,
  };
}

function buildClassifierSystemPrompt(): string {
  return [
    "You route assistant turns to the reasoning level most likely to produce a complete, source-grounded answer.",
    "Choose exactly one bucket: none, low, medium, high, or xhigh.",
    "",
    "Use none only for greetings, acknowledgments, and turns that need no substantive assistant work.",
    "Use low rarely: only for deterministic one-step answers or transformations with no tools, no current/external facts, no prior thread-context interpretation, and no source verification.",
    "Use medium for normal assistant work: explanations, source-backed checks, thread follow-ups, tool choice, likely tool use, ambiguous asks, multi-step analysis, or anything where a confident but shallow answer would be risky.",
    "Use high for research-heavy work, non-trivial drafting, or explicit requests to be thorough.",
    "Use xhigh for the most complex tasks: code changes, debugging/root-cause analysis, broad refactors, architecture decisions, multi-file implementation, or any task where deep reasoning across multiple systems or files is required.",
    "When unsure between two non-none buckets, choose the higher bucket. Do not use low as the default.",
    "",
    "Classify based on the substance of the task, not the length of the current message. When the current instruction is a short affirmation (for example: 'go', 'do it', 'yes please', 'proceed') and prior thread context contains a pending task, classify the pending task — not the affirmation.",
    "",
    "Return JSON only with reasoning_level, confidence, and reason.",
    "confidence must be a number from 0 to 1, not a word label.",
  ].join("\n");
}

function buildClassifierPrompt(args: {
  conversationContext?: TrimmedContext | null;
  currentTurnBlocks?: string[];
  messageText: string;
}): string {
  const sections: string[] = [];

  if (args.conversationContext) {
    const contextText = args.conversationContext.text;
    if (/^<thread-(compactions|transcript)>/.test(contextText)) {
      sections.push(contextText, "");
    } else {
      sections.push(
        "<thread-background>",
        contextText,
        "</thread-background>",
        "",
      );
    }
  }

  sections.push(renderCurrentInstruction(args.messageText.trim() || "[empty]"));

  for (const block of args.currentTurnBlocks ?? []) {
    const trimmed = block.trim();
    if (!trimmed) {
      continue;
    }
    sections.push("", trimmed);
  }

  return sections.join("\n");
}

/** Preserve an explicitly configured reasoning level without invoking the router. */
export function configuredTurnReasoningLevel(
  reasoningLevel: TurnReasoningLevel,
  source: "agent_config" | "default",
): TurnReasoningSelection {
  return {
    reasoningLevel,
    reason: `configured:${source}`,
  };
}

/** Choose the reasoning level for the upcoming assistant turn when none is configured. */
export async function selectTurnReasoningLevel(args: {
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
    actorId?: string;
    runId?: string;
    threadId?: string;
  };
  currentTurnBlocks?: string[];
  fastModelId: string;
  messageText: string;
}): Promise<TurnReasoningSelection> {
  const trimmedContext = trimContextForRouter(args.conversationContext);
  const instructionLength = args.messageText.trim().length;
  const turnBlockCount = (args.currentTurnBlocks ?? []).filter(
    (block) => block.trim().length > 0,
  ).length;
  const prompt = buildClassifierPrompt({
    conversationContext: trimmedContext,
    currentTurnBlocks: args.currentTurnBlocks,
    messageText: args.messageText,
  });

  const logContext: LogContext = {
    slackThreadId: args.context?.threadId,
    slackChannelId: args.context?.channelId,
    slackUserId: args.context?.actorId,
    runId: args.context?.runId,
    modelId: args.fastModelId,
  };

  return withSpan(
    "chat.route_reasoning",
    "chat.route_reasoning",
    logContext,
    async () => {
      setSpanAttributes({
        "app.ai.router.prompt_char_count": prompt.length,
        "app.ai.router.instruction_char_count": instructionLength,
        "app.ai.router.context_char_count":
          trimmedContext?.originalCharCount ?? 0,
        "app.ai.router.context_trimmed": trimmedContext?.truncated ?? false,
        "app.ai.router.turn_block_count": turnBlockCount,
      });

      const selection = await classifyTurn({
        completeObject: args.completeObject,
        fastModelId: args.fastModelId,
        metadata: {
          modelId: args.fastModelId,
          threadId: args.context?.threadId ?? "",
          channelId: args.context?.channelId ?? "",
          actorId: args.context?.actorId ?? "",
          runId: args.context?.runId ?? "",
        },
        prompt,
      });
      const normalizedSelection = applyReasoningFloor(selection, {
        minimum: trimmedContext || turnBlockCount > 0 ? "medium" : undefined,
      });

      setSpanAttributes({
        "app.ai.reasoning_level": normalizedSelection.reasoningLevel,
        "app.ai.reasoning_level_reason": normalizedSelection.reason,
        ...(normalizedSelection.confidence !== undefined
          ? {
              "app.ai.reasoning_level_confidence":
                normalizedSelection.confidence,
            }
          : {}),
      });

      return normalizedSelection;
    },
  );
}

function applyReasoningFloor(
  selection: TurnReasoningSelection,
  args: { minimum?: TurnReasoningLevel },
): TurnReasoningSelection {
  const minimum = args.minimum;
  if (
    !minimum ||
    selection.reasoningLevel === "none" ||
    REASONING_LEVEL_RANK[selection.reasoningLevel] >=
      REASONING_LEVEL_RANK[minimum]
  ) {
    return selection;
  }

  return {
    ...selection,
    reasoningLevel: minimum,
    reason: `reasoning_floor:${minimum}:${selection.reason}`,
  };
}

async function classifyTurn(args: {
  completeObject: Parameters<
    typeof selectTurnReasoningLevel
  >[0]["completeObject"];
  fastModelId: string;
  metadata: Record<string, string>;
  prompt: string;
}): Promise<TurnReasoningSelection> {
  try {
    const result = await args.completeObject({
      modelId: args.fastModelId,
      schema: turnExecutionProfileSchema,
      maxTokens: 120,
      metadata: args.metadata,
      prompt: args.prompt,
      thinkingLevel: "low",
      system: buildClassifierSystemPrompt(),
      temperature: 0,
    });

    const parsed = turnExecutionProfileSchema.parse(result.object);
    const reason = parsed.reason.trim();

    if (parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
      return {
        confidence: parsed.confidence,
        reasoningLevel: CLASSIFIER_FALLBACK_REASONING_LEVEL,
        reason: `low_confidence_medium_default:${reason}`,
      };
    }

    return {
      confidence: parsed.confidence,
      reasoningLevel: parsed.reasoning_level,
      reason,
    };
  } catch {
    return {
      reasoningLevel: CLASSIFIER_FALLBACK_REASONING_LEVEL,
      reason: "classifier_error_default",
    };
  }
}

/** Convert a routing bucket into the Pi Agent reasoning setting for a main turn. */
export function toPiReasoningLevel(
  level: TurnReasoningSelection["reasoningLevel"],
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
    case "xhigh":
      return "xhigh";
  }
}
