import type { ThinkingLevel as AgentThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ThinkingLevel as ProviderThinkingLevel } from "@earendil-works/pi-ai";
import { z } from "zod";
import { setSpanAttributes, withSpan, type LogContext } from "@/chat/logging";

const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.75;
const MAX_ROUTER_CONTEXT_CHARS = 8_000;
const ROUTER_CONTEXT_HEAD_CHARS = 3_000;
const ROUTER_CONTEXT_TAIL_CHARS = 5_000;
const TRUNCATION_MARKER = "\n…[truncated]…\n";
const TURN_THINKING_LEVELS = [
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

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
  thinking_level: z.enum(TURN_THINKING_LEVELS),
  confidence: z.preprocess(
    coerceClassifierConfidence,
    z.number().min(0).max(1),
  ),
  reason: z.string().min(1),
});

type TurnThinkingLevel = (typeof TURN_THINKING_LEVELS)[number];

export interface TurnThinkingSelection {
  confidence?: number;
  thinkingLevel: TurnThinkingLevel;
  reason: string;
}

const DEFAULT_THINKING_LEVEL: TurnThinkingSelection["thinkingLevel"] = "medium";
const THINKING_LEVEL_RANK: Record<TurnThinkingLevel, number> = {
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
    "You route assistant turns to the thinking level most likely to produce a complete, source-grounded answer.",
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
    "Return JSON only with thinking_level, confidence, and reason.",
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
    slackUserId: args.context?.requesterId,
    runId: args.context?.runId,
    modelId: args.fastModelId,
  };

  return withSpan(
    "chat.route_thinking",
    "chat.route_thinking",
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
          requesterId: args.context?.requesterId ?? "",
          runId: args.context?.runId ?? "",
        },
        prompt,
      });
      const normalizedSelection = applyThinkingFloor(selection, {
        minimum: trimmedContext || turnBlockCount > 0 ? "medium" : undefined,
      });

      setSpanAttributes({
        "app.ai.thinking_level": normalizedSelection.thinkingLevel,
        "app.ai.thinking_level_reason": normalizedSelection.reason,
        ...(normalizedSelection.confidence !== undefined
          ? {
              "app.ai.thinking_level_confidence":
                normalizedSelection.confidence,
            }
          : {}),
      });

      return normalizedSelection;
    },
  );
}

function applyThinkingFloor(
  selection: TurnThinkingSelection,
  args: { minimum?: TurnThinkingLevel },
): TurnThinkingSelection {
  const minimum = args.minimum;
  if (
    !minimum ||
    selection.thinkingLevel === "none" ||
    THINKING_LEVEL_RANK[selection.thinkingLevel] >= THINKING_LEVEL_RANK[minimum]
  ) {
    return selection;
  }

  return {
    ...selection,
    thinkingLevel: minimum,
    reason: `thinking_floor:${minimum}:${selection.reason}`,
  };
}

async function classifyTurn(args: {
  completeObject: Parameters<
    typeof selectTurnThinkingLevel
  >[0]["completeObject"];
  fastModelId: string;
  metadata: Record<string, string>;
  prompt: string;
}): Promise<TurnThinkingSelection> {
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
        thinkingLevel: DEFAULT_THINKING_LEVEL,
        reason: `low_confidence_medium_default:${reason}`,
      };
    }

    return {
      confidence: parsed.confidence,
      thinkingLevel: parsed.thinking_level,
      reason,
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
    case "xhigh":
      return "xhigh";
  }
}
