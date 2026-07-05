import {
  Agent,
  type AgentTool,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import { Type } from "@sinclair/typebox";
import { THREAD_STATE_TTL_MS } from "chat";
import type { AdvisorConfig } from "@/chat/config";
import {
  type ConversationPrivacy,
  toGenAiMessageMetadata,
  toGenAiMessagesTraceAttributes,
} from "@/chat/conversation-privacy";
import {
  extractGenAiUsageAttributes,
  serializeGenAiAttribute,
  setSpanAttributes,
  setSpanStatus,
  withSpan,
  type LogContext,
} from "@/chat/logging";
import {
  GEN_AI_PROVIDER_NAME,
  GEN_AI_SERVER_ADDRESS,
  GEN_AI_SERVER_PORT,
  getPiGatewayApiKey,
  resolveGatewayModel,
} from "@/chat/pi/client";
import type { PiMessage } from "@/chat/pi/messages";
import { extractAssistantText, isAssistantMessage } from "@/chat/pi/transcript";
import {
  createStateAdvisorSessionStore,
  getAdvisorSessionKey,
  type AdvisorSessionStore,
} from "@/chat/tools/advisor/session-store";
import {
  recordSubagentEnded,
  recordSubagentStarted,
} from "@/chat/state/session-log";
import { tool, type AnyToolDefinition } from "@/chat/tools/definition";
import { escapeXml } from "@/chat/xml";

export type AdvisorErrorCode =
  | "invalid_context"
  | "invalid_question"
  | "missing_conversation_id"
  | "session_unavailable"
  | "unavailable";

export interface AdvisorToolResult {
  content: [{ type: "text"; text: string }];
  details:
    | {
        ok: true;
      }
    | {
        error_code: AdvisorErrorCode;
        ok: false;
      };
}

export interface AdvisorToolRuntimeContext {
  config: AdvisorConfig;
  conversationId?: string;
  conversationPrivacy?: ConversationPrivacy;
  getTools: () => AgentTool[];
  logContext?: LogContext;
  parentSessionId?: string;
  store?: AdvisorSessionStore;
  streamFn?: StreamFn;
}

const ADVISOR_TOOL_DESCRIPTION =
  "Second-opinion advisor for hard technical work. Call when you reach a consequential workflow moment: after enough exploration to frame a non-obvious plan; before a non-trivial code change or broad refactor; after repeated failures or when requirements or next steps feel ambiguous or risky; and when verifying a complex change before declaring it done, opening a PR, or reporting results. Ask a focused question and pass curated context: exact evidence, constraints, relevant code snippets, command output, diffs, current plan, and alternatives considered. The advisor has its own history, does not automatically receive the parent transcript, and may use read-only tools to verify. Follow up only with new evidence or changed constraints. Do not use for greetings, simple deterministic edits, routine formatting, or when fresh output makes the next action obvious.";

const ADVISOR_SYSTEM_PROMPT = [
  "You are a senior technical advisor for the executor.",
  "Analyze the executor-supplied context deeply. Use read-only tools when direct inspection or verification would materially improve the advice.",
  "Distinguish evidence from inference. Treat the advisor task as the focus for this call and the executor context as the starting evidence packet.",
  "Do not assume access to parent transcript or tool output that was not included or gathered in this advisor call.",
  "Use only the read-only tools provided to you.",
  "Do not make user-visible side effects, post Slack messages, or mutate files. If a mutating action is needed, recommend it to the executor instead.",
  "Identify the hard part, recommend a concrete plan or correction, call out blocking risks, and propose focused verification.",
  "If the supplied context is insufficient, say exactly what additional evidence the executor needs to gather before acting.",
  "Do not write user-facing prose.",
  "Use concise technical memo sections when helpful: Assessment, Recommended Plan, Risks, Verification, Stop Conditions.",
].join("\n");

function lastAssistantMessage(messages: readonly unknown[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (isAssistantMessage(message)) {
      return message;
    }
  }
  return undefined;
}

function failure(
  errorCode: AdvisorErrorCode,
  text = `Advisor guidance is unavailable (${errorCode}). Continue only if the next step is clear from verified evidence.`,
): AdvisorToolResult {
  return {
    content: [{ type: "text", text }],
    details: {
      ok: false,
      error_code: errorCode,
    },
  };
}

function success(memo: string): AdvisorToolResult {
  return {
    content: [{ type: "text", text: memo }],
    details: {
      ok: true,
    },
  };
}

function hasReadOnlyToolAnnotations(
  annotations: AnyToolDefinition["annotations"],
): boolean {
  return (
    annotations?.readOnlyHint === true && annotations.destructiveHint !== true
  );
}

/** Build the advisor's read-only tool definition subset. */
export function createAdvisorToolDefinitions(
  definitions: Record<string, AnyToolDefinition>,
): Record<string, AnyToolDefinition> {
  return Object.fromEntries(
    Object.entries(definitions).filter(
      ([name, definition]) =>
        name !== "callMcpTool" &&
        name !== "searchMcpTools" &&
        hasReadOnlyToolAnnotations(definition.annotations),
    ),
  );
}

/** Create the advisor tool backed by conversation-scoped message history. */
export function createAdvisorTool(context: AdvisorToolRuntimeContext) {
  const store = context.store ?? createStateAdvisorSessionStore();
  const spanContext = context.logContext ?? {};

  return tool({
    description: ADVISOR_TOOL_DESCRIPTION,
    inputSchema: Type.Object({
      question: Type.String({
        minLength: 1,
        description: "Focused advisor question or decision point.",
      }),
      context: Type.String({
        minLength: 1,
        description:
          "Curated evidence packet: relevant requirements, constraints, current plan, alternatives, code snippets, diffs, command output, and open questions.",
      }),
    }),
    execute: async (
      { question, context: suppliedContext },
      { toolCallId } = {},
    ) => {
      if (typeof question !== "string" || !question.trim()) {
        return failure(
          "invalid_question",
          "Advisor guidance is unavailable because the question was empty or invalid. Ask a focused advisor question before retrying.",
        );
      }
      const advisorQuestion = question.trim();

      if (typeof suppliedContext !== "string" || !suppliedContext.trim()) {
        return failure(
          "invalid_context",
          "Advisor guidance is unavailable because the curated context was empty or invalid. Include the relevant evidence and constraints before retrying.",
        );
      }
      const advisorContext = suppliedContext.trim();

      if (!context.conversationId) {
        return failure(
          "missing_conversation_id",
          "Advisor guidance is unavailable because this turn has no parent conversation id. Continue without assuming advisor history.",
        );
      }

      const conversationId = context.conversationId;
      const advisorSessionKey = getAdvisorSessionKey(conversationId);
      const subagentInvocationId =
        typeof toolCallId === "string" && toolCallId.length > 0
          ? toolCallId
          : `advisor:${Date.now()}`;
      const endSubagent = async (
        outcome: "success" | "error" | "aborted",
        errorCode?: AdvisorErrorCode,
        transcriptRange?: {
          endMessageIndex: number;
          startMessageIndex: number;
        },
      ) =>
        recordSubagentEnded({
          conversationId,
          sessionId: context.parentSessionId,
          subagentInvocationId,
          outcome,
          ...(errorCode ? { errorCode } : {}),
          ...(transcriptRange
            ? {
                transcriptEndMessageIndex: transcriptRange.endMessageIndex,
                transcriptStartMessageIndex: transcriptRange.startMessageIndex,
              }
            : {}),
          ttlMs: THREAD_STATE_TTL_MS,
        });
      await recordSubagentStarted({
        conversationId,
        sessionId: context.parentSessionId,
        parentConversationId: conversationId,
        parentSessionId: context.parentSessionId,
        ...(typeof toolCallId === "string" && toolCallId.length > 0
          ? { parentToolCallId: toolCallId }
          : {}),
        subagentInvocationId,
        subagentKind: "advisor",
        transcriptRef: {
          type: "advisor_session",
          parentConversationId: conversationId,
          key: advisorSessionKey,
        },
        historyMode: "shared",
        ttlMs: THREAD_STATE_TTL_MS,
      });
      const conversationPrivacy = context.conversationPrivacy ?? "private";
      const requestText = [
        "<advisor-task>",
        escapeXml(advisorQuestion),
        "</advisor-task>",
        "",
        "<executor-context>",
        escapeXml(advisorContext),
        "</executor-context>",
      ].join("\n");
      const advisorInputMessage = {
        role: "user",
        content: [
          {
            type: "text",
            text: requestText,
          },
        ],
      };
      const advisorInputMessagesAttribute = serializeGenAiAttribute(
        conversationPrivacy !== "public"
          ? [toGenAiMessageMetadata(advisorInputMessage)]
          : [advisorInputMessage],
      );

      return await withSpan(
        `invoke_agent ${context.config.modelId}`,
        "gen_ai.invoke_agent",
        spanContext,
        async () => {
          const requestMessage: PiMessage = {
            role: "user",
            content: [{ type: "text", text: requestText }],
            timestamp: Date.now(),
          };

          let advisorMessages: PiMessage[];
          try {
            advisorMessages = await store.load(conversationId);
          } catch {
            setSpanStatus("error");
            await endSubagent("error", "session_unavailable");
            return failure(
              "session_unavailable",
              "Advisor guidance is unavailable because advisor history could not be loaded. Continue without assuming advisor history.",
            );
          }

          const apiKeyOverride = getPiGatewayApiKey();
          const advisorAgent = new Agent({
            ...(apiKeyOverride ? { getApiKey: () => apiKeyOverride } : {}),
            initialState: {
              systemPrompt: ADVISOR_SYSTEM_PROMPT,
              model: resolveGatewayModel(context.config.modelId),
              thinkingLevel: context.config.thinkingLevel,
              tools: context.getTools(),
            },
            sessionId: advisorSessionKey,
            streamFn: context.streamFn,
          });
          advisorAgent.state.messages = advisorMessages;
          const beforeMessageCount = advisorAgent.state.messages.length;

          try {
            await advisorAgent.prompt(requestMessage);
          } catch {
            setSpanStatus("error");
            await endSubagent("error", "unavailable");
            return failure(
              "unavailable",
              "Advisor guidance is unavailable. Continue without advisor guidance if the next step is clear from verified evidence.",
            );
          }

          const assistant = lastAssistantMessage(advisorAgent.state.messages);
          const newAdvisorMessages =
            advisorAgent.state.messages.slice(beforeMessageCount);
          const outputMessages = newAdvisorMessages.filter(isAssistantMessage);
          const outputMessagesAttribute = serializeGenAiAttribute(
            conversationPrivacy !== "public"
              ? outputMessages.map(toGenAiMessageMetadata)
              : outputMessages,
          );
          setSpanAttributes({
            ...(outputMessagesAttribute
              ? { "gen_ai.output.messages": outputMessagesAttribute }
              : {}),
            ...toGenAiMessagesTraceAttributes("app.ai.output", outputMessages),
            ...extractGenAiUsageAttributes(...newAdvisorMessages),
          });

          if (
            !assistant ||
            assistant.stopReason === "error" ||
            assistant.stopReason === "aborted"
          ) {
            setSpanStatus("error");
            await endSubagent(
              assistant?.stopReason === "aborted" ? "aborted" : "error",
              "unavailable",
            );
            return failure(
              "unavailable",
              "Advisor guidance is unavailable. Continue without advisor guidance if the next step is clear from verified evidence.",
            );
          }

          const memo = extractAssistantText(assistant);
          try {
            await store.save(conversationId, advisorAgent.state.messages);
          } catch {
            setSpanStatus("error");
            await endSubagent("error", "session_unavailable");
            return failure(
              "session_unavailable",
              "Advisor guidance is unavailable because advisor history could not be saved. Retry the advisor call or continue without assuming advisor history.",
            );
          }
          await endSubagent("success", undefined, {
            endMessageIndex: advisorAgent.state.messages.length,
            startMessageIndex: beforeMessageCount,
          });
          setSpanStatus("ok");
          return success(memo);
        },
        {
          "gen_ai.provider.name": GEN_AI_PROVIDER_NAME,
          "gen_ai.operation.name": "invoke_agent",
          "gen_ai.request.model": context.config.modelId,
          "gen_ai.output.type": "text",
          "server.address": GEN_AI_SERVER_ADDRESS,
          "server.port": GEN_AI_SERVER_PORT,
          "app.conversation.privacy": conversationPrivacy,
          ...toGenAiMessagesTraceAttributes("app.ai.input", [
            advisorInputMessage,
          ]),
          ...(advisorInputMessagesAttribute
            ? { "gen_ai.input.messages": advisorInputMessagesAttribute }
            : {}),
        },
      );
    },
  });
}
