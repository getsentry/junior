import type {
  AgentContext,
  AgentLoopTurnUpdate,
} from "@earendil-works/pi-agent-core";
import type { ConversationMessageProvenance } from "@/chat/conversations/provenance";
import type { UserContentPart } from "@/chat/agent/prompt";
import type { PiMessage } from "@/chat/pi/messages";
import {
  AGENTS_REMOVAL_NOTICE,
  AGENTS_REPLACEMENT_NOTICE,
  buildAgentsInstructionsMessage,
  findVisibleAgentsInstructions,
  type RepositoryInstructions,
} from "@/chat/repository-instructions";

type RepositoryInstructionsContextOptions = {
  capture(): Promise<RepositoryInstructions | undefined>;
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
    async applyUpdate(
      currentUpdate: AgentLoopTurnUpdate | undefined,
      currentContext: AgentContext,
    ): Promise<AgentLoopTurnUpdate | undefined> {
      if (!options.hasSandbox()) {
        return currentUpdate;
      }
      const instructions = await options.capture();
      if (
        instructions &&
        instructions.fingerprint === visibleFingerprint &&
        instructionsVisible
      ) {
        return currentUpdate;
      }
      if (!instructions && !instructionsVisible) {
        return currentUpdate;
      }

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
      visibleFingerprint = instructions?.fingerprint;
      instructionsVisible = Boolean(instructions);
      await options.onTransition?.(instructions);
      return {
        ...currentUpdate,
        context: { ...context, messages },
      };
    },
  };
}
