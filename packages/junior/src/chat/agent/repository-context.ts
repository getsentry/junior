import type {
  AgentContext,
  AgentLoopTurnUpdate,
} from "@earendil-works/pi-agent-core";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { UserContentPart } from "@/chat/agent/prompt";
import type { PiMessage } from "@/chat/pi/messages";
import { withSpan } from "@/chat/logging";
import {
  AGENTS_REMOVAL_NOTICE,
  AGENTS_REPLACEMENT_NOTICE,
  buildAgentsInstructionsMessage,
  findVisibleAgentsInstructions,
  type RepositoryInstructions,
} from "@/chat/repository-instructions";

/** Result of one AGENTS.md check before a model call. */
type RepositoryInstructionsRefreshOutcome =
  | "added"
  | "none"
  | "removed"
  | "unchanged"
  | "updated";

type RepositoryInstructionsContextOptions = {
  capture(): Promise<RepositoryInstructions | undefined>;
  /** Commit history that ends with a new AGENTS.md message. */
  commit(messages: PiMessage[]): Promise<void>;
  hasSandbox(): boolean;
  initialInstructions?: RepositoryInstructions;
  onTransition?: (
    instructions: RepositoryInstructions | undefined,
  ) => void | Promise<void>;
  restoredMessages?: PiMessage[];
  restoredProvenance?: ConversationMessageProvenance[];
  promptContextContentParts: UserContentPart[];
  setMessages(messages: PiMessage[]): void;
  shouldPromptAgent: boolean;
};

function findRestoredInstructions(
  messages: PiMessage[] | undefined,
  provenance: ConversationMessageProvenance[] | undefined,
) {
  const restoredContext = messages
    ?.map((message, index) => ({ message, provenance: provenance?.[index] }))
    .reverse()
    .find(({ message, provenance: messageProvenance }) =>
      messageProvenance?.authority === "context"
        ? Boolean(findVisibleAgentsInstructions([message]))
        : false,
    );
  return restoredContext
    ? findVisibleAgentsInstructions([restoredContext.message])
    : undefined;
}

/** Track model-visible AGENTS.md state and append updates before later samples. */
export function createRepositoryInstructionsContext(
  options: RepositoryInstructionsContextOptions,
) {
  const visibleInstructions = options.shouldPromptAgent
    ? findVisibleAgentsInstructions([
        {
          role: "user",
          content: options.promptContextContentParts,
        } as PiMessage,
      ])
    : findRestoredInstructions(
        options.restoredMessages,
        options.restoredProvenance,
      );
  let instructionsVisible = visibleInstructions?.active === true;
  let visibleFingerprint =
    options.initialInstructions &&
    visibleInstructions?.active === true &&
    visibleInstructions.directory === options.initialInstructions.directory &&
    visibleInstructions.text === options.initialInstructions.text
      ? options.initialInstructions.fingerprint
      : undefined;
  return {
    /** Re-read AGENTS.md and append a context message when it changed. */
    async applyUpdate(
      currentUpdate: AgentLoopTurnUpdate | undefined,
      currentContext: AgentContext,
    ): Promise<AgentLoopTurnUpdate | undefined> {
      if (!options.hasSandbox()) {
        return currentUpdate;
      }
      return await withSpan(
        "agent.repository_instructions.refresh",
        "agent.repository_instructions.refresh",
        {},
        async (setSpanAttributes) => {
          const instructions = await options.capture();
          const outcome = refreshOutcome(instructions);
          setSpanAttributes({ "app.repository_instructions.outcome": outcome });
          if (outcome === "unchanged" || outcome === "none") {
            return currentUpdate;
          }
          return await appendUpdate(
            instructions,
            currentUpdate,
            currentContext,
          );
        },
      );
    },
  };

  function refreshOutcome(
    instructions: RepositoryInstructions | undefined,
  ): RepositoryInstructionsRefreshOutcome {
    if (!instructions) {
      return instructionsVisible ? "removed" : "none";
    }
    if (!instructionsVisible) {
      return "added";
    }
    return instructions.fingerprint === visibleFingerprint
      ? "unchanged"
      : "updated";
  }

  async function appendUpdate(
    instructions: RepositoryInstructions | undefined,
    currentUpdate: AgentLoopTurnUpdate | undefined,
    currentContext: AgentContext,
  ): Promise<AgentLoopTurnUpdate> {
    const message = instructions
      ? buildAgentsInstructionsMessage({
          directory: instructions.directory,
          text: instructionsVisible
            ? `${AGENTS_REPLACEMENT_NOTICE}\n\n${instructions.text}`
            : instructions.text,
        })
      : buildAgentsInstructionsMessage({ text: AGENTS_REMOVAL_NOTICE });
    const context = currentUpdate?.context ?? currentContext;
    const messages = [...(context.messages as PiMessage[]), message];
    options.setMessages(messages);
    // A final reply is committed directly after the current history, so
    // this message must be committed first.
    await options.commit(messages);
    visibleFingerprint = instructions?.fingerprint;
    instructionsVisible = Boolean(instructions);
    await options.onTransition?.(instructions);
    return {
      ...currentUpdate,
      context: { ...context, messages },
    };
  }
}
