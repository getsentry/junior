import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { z } from "zod";

const ACKNOWLEDGMENT_ONLY_RE =
  /^(?:thanks(?: you)?|thank you|thx|ty|got it|sounds good|sgtm|lgtm|ok(?:ay)?|cool|nice|perfect|awesome|great|makes sense|understood|roger|yep|yup|kk|done)(?:[.!?]+)?$/i;
const SIMPLE_TRANSACTIONAL_RE =
  /^(?:hi|hello|hey|what time is it|what's the time|translate this|summari[sz]e this)\b/i;
const CODE_CHANGE_RE =
  /\b(?:fix|implement|patch|refactor|rename|edit|modify|update|add|remove|delete|write)\b/i;
const CODE_OBJECT_RE =
  /\b(?:bug|code|test|file|module|function|handler|component|eval|spec|issue|pr|pull request|repo|repository|codebase)\b/i;
const DEBUG_RE =
  /\b(?:debug|diagnose|troubleshoot|root cause|track down|failure|failing|broken)\b/i;
const THOROUGH_RE =
  /\b(?:be thorough|thoroughly|deep dive|research|repo archaeology|survey|compare|exhaustive)\b/i;
const INVESTIGATION_RE =
  /\b(?:dig into|look into|investigate|analyze|analyse|walk me through|explain|trace through)\b/i;
const DRAFT_RE = /\b(?:draft|compose|write)\b/i;
const DRAFT_TARGET_RE =
  /\b(?:pr|pull request|issue|proposal|spec|design doc|docs?)\b/i;
const FAILURE_RISK_RE =
  /\b(?:unclear|ambiguous|not sure|unsure|maybe|double-check|confirm|verify|risky|failure-prone)\b/i;
const REPO_REFERENCE_RE =
  /\b(?:repo|repository|codebase|issue|issues|pr|pull request|file|files|module|function|test|eval|spec)\b/i;
const URL_RE = /https?:\/\/\S+/gi;
const FILE_PATH_RE = /\b(?:[\w.-]+\/)+[\w.-]+\.[a-z0-9]+\b/gi;
const CLASSIFIER_CONFIDENCE_THRESHOLD = 0.75;
const MAX_ROUTER_CONTEXT_CHARS = 1_200;

const turnExecutionProfileSchema = z.object({
  reasoning_effort: z.enum(["none", "low", "medium", "high"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().min(1),
});

export interface TurnExecutionProfile {
  confidence?: number;
  modelId: string;
  reasoningEffort: "none" | "low" | "medium" | "high";
  reason: string;
  source: "heuristic" | "classifier";
}

const DEFAULT_REASONING_EFFORT: TurnExecutionProfile["reasoningEffort"] = "low";

interface TurnExecutionProfileSignals {
  activeSkillNames: string[];
  attachmentCount: number;
  conversationContextChars: number;
  filePathCount: number;
  hasCodeChangeCue: boolean;
  hasDebugCue: boolean;
  hasDraftingCue: boolean;
  hasFailureRisk: boolean;
  hasInvestigationCue: boolean;
  hasPotentialComplexity: boolean;
  hasRepoReference: boolean;
  hasResearchHeavyCue: boolean;
  isAcknowledgmentOnly: boolean;
  isVerySimpleRequest: boolean;
  urlCount: number;
  wordCount: number;
}

function countMatches(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

function trimContextForRouter(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.length <= MAX_ROUTER_CONTEXT_CHARS
    ? trimmed
    : trimmed.slice(-MAX_ROUTER_CONTEXT_CHARS);
}

function buildSignals(args: {
  activeSkillNames?: string[];
  attachmentCount?: number;
  conversationContext?: string;
  messageText: string;
}): TurnExecutionProfileSignals {
  const text = args.messageText.trim();
  const activeSkillNames = [...new Set(args.activeSkillNames ?? [])].sort();
  const attachmentCount = args.attachmentCount ?? 0;
  const conversationContextChars = args.conversationContext?.trim().length ?? 0;
  const urlCount = countMatches(text, URL_RE);
  const filePathCount = countMatches(text, FILE_PATH_RE);
  const wordCount = text
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean).length;
  const hasRepoReference =
    REPO_REFERENCE_RE.test(text) ||
    urlCount > 0 ||
    filePathCount > 0 ||
    activeSkillNames.length > 0;
  const hasCodeChangeCue =
    CODE_CHANGE_RE.test(text) &&
    (CODE_OBJECT_RE.test(text) ||
      filePathCount > 0 ||
      urlCount > 0 ||
      activeSkillNames.length > 0);
  const hasDebugCue = DEBUG_RE.test(text);
  const hasResearchHeavyCue = THOROUGH_RE.test(text);
  const hasInvestigationCue = INVESTIGATION_RE.test(text);
  const hasDraftingCue = DRAFT_RE.test(text) && DRAFT_TARGET_RE.test(text);
  const isAcknowledgmentOnly = ACKNOWLEDGMENT_ONLY_RE.test(text);
  const isVerySimpleRequest =
    !hasRepoReference &&
    !hasCodeChangeCue &&
    !hasDebugCue &&
    !hasResearchHeavyCue &&
    !hasInvestigationCue &&
    !hasDraftingCue &&
    (isAcknowledgmentOnly ||
      (wordCount <= 5 && SIMPLE_TRANSACTIONAL_RE.test(text)));
  const hasFailureRisk =
    FAILURE_RISK_RE.test(text) || conversationContextChars > 600;
  const hasPotentialComplexity =
    hasRepoReference ||
    attachmentCount > 0 ||
    hasFailureRisk ||
    hasInvestigationCue ||
    activeSkillNames.length > 0;

  return {
    activeSkillNames,
    attachmentCount,
    conversationContextChars,
    filePathCount,
    hasCodeChangeCue,
    hasDebugCue,
    hasDraftingCue,
    hasFailureRisk,
    hasInvestigationCue,
    hasPotentialComplexity,
    hasRepoReference,
    hasResearchHeavyCue,
    isAcknowledgmentOnly,
    isVerySimpleRequest,
    urlCount,
    wordCount,
  };
}

function buildHeuristicProfile(
  modelId: string,
  signals: TurnExecutionProfileSignals,
): TurnExecutionProfile | undefined {
  if (signals.hasCodeChangeCue) {
    return {
      modelId,
      reasoningEffort: "high",
      reason: "code_change_request",
      source: "heuristic",
    };
  }

  if (signals.hasDebugCue) {
    return {
      modelId,
      reasoningEffort: "high",
      reason: "debugging_or_failure_analysis",
      source: "heuristic",
    };
  }

  if (signals.hasResearchHeavyCue) {
    return {
      modelId,
      reasoningEffort: "high",
      reason: "explicit_thorough_or_research_request",
      source: "heuristic",
    };
  }

  if (signals.hasDraftingCue) {
    return {
      modelId,
      reasoningEffort: "high",
      reason: "non_trivial_drafting_request",
      source: "heuristic",
    };
  }

  if (signals.hasInvestigationCue && signals.hasRepoReference) {
    return {
      modelId,
      reasoningEffort: "medium",
      reason: "repo_investigation_request",
      source: "heuristic",
    };
  }

  if (signals.isAcknowledgmentOnly) {
    return {
      modelId,
      reasoningEffort: "none",
      reason: "acknowledgment_only",
      source: "heuristic",
    };
  }

  if (signals.isVerySimpleRequest) {
    return {
      modelId,
      reasoningEffort: "none",
      reason: "simple_transactional_request",
      source: "heuristic",
    };
  }

  if (!signals.hasPotentialComplexity) {
    return {
      modelId,
      reasoningEffort: "low",
      reason: "default_simple_turn",
      source: "heuristic",
    };
  }

  return undefined;
}

function buildClassifierSystemPrompt(): string {
  return [
    "You route coding-assistant turns to the cheapest reasoning effort that is still likely to succeed.",
    "Choose exactly one bucket: none, low, medium, or high.",
    "",
    "Use none for greetings, acknowledgments, and trivial single-step asks.",
    "Use low for straightforward explanations or simple one-step work.",
    "Use medium for repo investigation, multi-file analysis, ambiguous asks, or likely multi-tool work.",
    "Use high for code changes, debugging/root-cause analysis, research-heavy work, non-trivial drafting, or explicit requests to be thorough.",
    "",
    "Prefer the cheaper bucket when the task is clearly simple.",
    "If the task looks ambiguous or failure-prone, do not stay at none.",
    "Return JSON only with reasoning_effort, confidence, and reason.",
  ].join("\n");
}

function buildClassifierPrompt(args: {
  activeSkillNames: string[];
  conversationContext?: string;
  messageText: string;
  signals: TurnExecutionProfileSignals;
}): string {
  const sections = [
    "Latest user request:",
    args.messageText.trim() || "[empty]",
    "",
    "Signals:",
    `- active_skills: ${args.activeSkillNames.join(", ") || "none"}`,
    `- url_count: ${args.signals.urlCount}`,
    `- file_path_count: ${args.signals.filePathCount}`,
    `- attachment_count: ${args.signals.attachmentCount}`,
    `- conversation_context_chars: ${args.signals.conversationContextChars}`,
    `- has_repo_reference: ${args.signals.hasRepoReference}`,
    `- has_investigation_cue: ${args.signals.hasInvestigationCue}`,
    `- has_failure_risk: ${args.signals.hasFailureRisk}`,
    `- word_count: ${args.signals.wordCount}`,
  ];

  const context = trimContextForRouter(args.conversationContext);
  if (context) {
    sections.push("", "Recent conversation context:", context);
  }

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
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
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
  const signals = buildSignals(args);
  const heuristicProfile = buildHeuristicProfile(args.modelId, signals);
  if (heuristicProfile) {
    return heuristicProfile;
  }

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
        activeSkillNames: signals.activeSkillNames,
        conversationContext: args.conversationContext,
        messageText: args.messageText,
        signals,
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
        source: "classifier",
      };
    }

    return {
      confidence: parsed.confidence,
      modelId: args.modelId,
      reasoningEffort: parsed.reasoning_effort,
      reason: parsed.reason.trim(),
      source: "classifier",
    };
  } catch {
    return {
      modelId: args.modelId,
      reasoningEffort: DEFAULT_REASONING_EFFORT,
      reason: "classifier_error_default",
      source: "classifier",
    };
  }
}

/** Convert a routing effort bucket into the Pi Agent thinking level for a main turn. */
export function toAgentThinkingLevel(
  effort: TurnExecutionProfile["reasoningEffort"],
): ThinkingLevel | "off" {
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
