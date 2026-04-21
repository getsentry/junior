import type { ThinkingLevel as AgentThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ThinkingLevel as ProviderThinkingLevel } from "@mariozechner/pi-ai";
import { z } from "zod";

const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.75;
const MAX_ROUTER_CONTEXT_CHARS = 1_200;
const TURN_REASONING_EFFORTS = ["none", "low", "medium", "high"] as const;

const turnExecutionProfileSchema = z.object({
  reasoning_effort: z.enum(TURN_REASONING_EFFORTS),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

type TurnReasoningEffort = (typeof TURN_REASONING_EFFORTS)[number];

export interface TurnExecutionProfile {
  confidence?: number;
  modelId: string;
  reasoningEffort: TurnReasoningEffort;
  reason: string;
}

const DEFAULT_REASONING_EFFORT: TurnExecutionProfile["reasoningEffort"] = "low";

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
    "You route assistant turns to the cheapest reasoning effort that is still likely to succeed.",
    "Choose exactly one bucket: none, low, medium, or high.",
    "",
    "Use none for greetings, acknowledgments, and trivial single-step asks.",
    "Use low for straightforward explanations or simple one-step work.",
    "Use medium for investigations, ambiguous asks, multi-step analysis, or likely multi-tool work.",
    "Use high for code changes, debugging/root-cause analysis, research-heavy work, non-trivial drafting, or explicit requests to be thorough.",
    "",
    "Return JSON only with reasoning_effort, confidence, and reason.",
  ].join("\n");
}

function buildClassifierPrompt(args: {
  activeSkillNames: string[];
  attachmentCount: number;
  conversationContext?: string;
  messageText: string;
}): string {
  const sections: string[] = [];

  const context = trimContextForRouter(args.conversationContext);
  if (context) {
    sections.push("<thread-background>", context, "</thread-background>", "");
  }

  sections.push(
    "<turn-context>",
    `- active_skills: ${args.activeSkillNames.join(", ") || "none"}`,
    `- attachment_count: ${args.attachmentCount}`,
    "</turn-context>",
    "",
    '<current-instruction priority="highest">',
    args.messageText.trim() || "[empty]",
    "</current-instruction>",
  );

  return sections.join("\n");
}

/** Choose the model and reasoning budget for the upcoming assistant turn. */
export async function selectTurnExecutionProfile(args: {
  activeSkillNames?: string[];
  attachmentCount?: number;
  completeObject: (args: {
    modelId: string;
    schema: typeof turnExecutionProfileSchema;
    maxTokens: number;
    metadata: Record<string, string>;
    prompt: string;
    reasoningEffort?: ProviderThinkingLevel;
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
  fastModelId: string;
  messageText: string;
  modelId: string;
}): Promise<TurnExecutionProfile> {
  const activeSkillNames = [...new Set(args.activeSkillNames ?? [])].sort();

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
        activeSkillNames,
        attachmentCount: args.attachmentCount ?? 0,
        conversationContext: args.conversationContext,
        messageText: args.messageText,
      }),
      reasoningEffort: "low",
      system: buildClassifierSystemPrompt(),
      temperature: 0,
    });

    const parsed = turnExecutionProfileSchema.parse(result.object);
    if (parsed.confidence < CLASSIFIER_CONFIDENCE_THRESHOLD) {
      return {
        confidence: parsed.confidence,
        modelId: args.modelId,
        reasoningEffort: DEFAULT_REASONING_EFFORT,
        reason: `low_confidence_default:${parsed.reason.trim()}`,
      };
    }

    return {
      confidence: parsed.confidence,
      modelId: args.modelId,
      reasoningEffort: parsed.reasoning_effort,
      reason: parsed.reason.trim(),
    };
  } catch {
    return {
      modelId: args.modelId,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      reason: "classifier_error_default",
    };
  }
}

/** Convert a routing effort bucket into the Pi Agent thinking level for a main turn. */
export function toAgentThinkingLevel(
  effort: TurnExecutionProfile["reasoningEffort"],
): AgentThinkingLevel | "off" {
  switch (effort) {
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
