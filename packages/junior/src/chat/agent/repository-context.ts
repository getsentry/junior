import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { UserContentPart } from "@/chat/agent/prompt";
import type { PiMessage } from "@/chat/pi/messages";
import { withSpan } from "@/chat/logging";
import {
  AGENTS_REMOVAL_NOTICE,
  AGENTS_REPLACEMENT_NOTICE,
  buildAgentsInstructionsMessage,
  findVisibleAgentsInstructions,
  showsAgentsInstructions,
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
  onTransition?: (
    instructions: RepositoryInstructions | undefined,
  ) => void | Promise<void>;
  restoredMessages?: PiMessage[] | undefined;
  restoredProvenance?: ConversationMessageProvenance[] | undefined;
  promptContextContentParts: UserContentPart[];
  /** History before a new prompt. It can hold AGENTS.md from earlier Turns. */
  promptHistoryMessages: PiMessage[];
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
  // Compare against the text the model sees, not a fingerprint: a Turn that
  // starts without a sandbox has no captured instructions to fingerprint.
  let visibleInstructions = options.shouldPromptAgent
    ? findVisibleAgentsInstructions([
        ...options.promptHistoryMessages,
        {
          role: "user",
          content: options.promptContextContentParts,
        } as PiMessage,
      ])
    : findRestoredInstructions(
        options.restoredMessages,
        options.restoredProvenance,
      );
  return {
    /**
     * Re-read AGENTS.md and append a context message to `messages` when it
     * changed. Returns whether it set new messages.
     */
    async applyUpdate(messages: PiMessage[]): Promise<boolean> {
      if (!options.hasSandbox()) {
        return false;
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
            return false;
          }
          await appendUpdate(instructions, messages);
          return true;
        },
      );
    },
  };

  function refreshOutcome(
    instructions: RepositoryInstructions | undefined,
  ): RepositoryInstructionsRefreshOutcome {
    const instructionsVisible = visibleInstructions?.active === true;
    if (!instructions) {
      return instructionsVisible ? "removed" : "none";
    }
    if (!instructionsVisible) {
      return "added";
    }
    return showsAgentsInstructions(visibleInstructions, instructions)
      ? "unchanged"
      : "updated";
  }

  async function appendUpdate(
    instructions: RepositoryInstructions | undefined,
    currentMessages: PiMessage[],
  ): Promise<void> {
    const message = instructions
      ? buildAgentsInstructionsMessage({
          directory: instructions.directory,
          text:
            visibleInstructions?.active === true
              ? `${AGENTS_REPLACEMENT_NOTICE}\n\n${instructions.text}`
              : instructions.text,
        })
      : buildAgentsInstructionsMessage({ text: AGENTS_REMOVAL_NOTICE });
    const messages = [...currentMessages, message];
    options.setMessages(messages);
    // A final response is committed directly after the current history, so
    // this message must be committed first.
    await options.commit(messages);
    visibleInstructions = instructions
      ? {
          active: true,
          directory: instructions.directory,
          text: instructions.text,
        }
      : { active: false };
    await options.onTransition?.(instructions);
  }
}
