import type { PiMessage } from "@/chat/pi/messages";

interface ScriptedReplyAgentOptions {
  initialState: {
    model: unknown;
    systemPrompt: string;
    thinkingLevel?: unknown;
    tools: unknown[];
  };
  prepareNextTurn?: () => Promise<unknown> | unknown;
}

export interface ScriptedReplyAgent {
  prepareNextTurn?: () => Promise<unknown> | unknown;
  state: {
    messages: PiMessage[];
    model: unknown;
    systemPrompt: string;
    thinkingLevel?: unknown;
    tools: unknown[];
  };
  steeringMessages: PiMessage[];
}

export interface ScriptedReplyAgentScript {
  abort?: (agent: ScriptedReplyAgent) => void;
  continue: (agent: ScriptedReplyAgent) => Promise<unknown>;
  prompt: (agent: ScriptedReplyAgent, message: unknown) => Promise<unknown>;
  steer?: (agent: ScriptedReplyAgent, message: unknown) => void;
}

class TestReplyAgent implements ScriptedReplyAgent {
  prepareNextTurn?: () => Promise<unknown> | unknown;
  state: ScriptedReplyAgent["state"];
  steeringMessages: PiMessage[] = [];

  constructor(
    options: ScriptedReplyAgentOptions,
    private readonly script: ScriptedReplyAgentScript,
  ) {
    this.prepareNextTurn = options.prepareNextTurn;
    this.state = {
      messages: [],
      model: options.initialState.model,
      systemPrompt: options.initialState.systemPrompt,
      thinkingLevel: options.initialState.thinkingLevel,
      tools: options.initialState.tools,
    };
  }

  abort(): void {
    this.script.abort?.(this);
  }

  async continue(): Promise<unknown> {
    return await this.script.continue(this);
  }

  async prompt(message: unknown): Promise<unknown> {
    return await this.script.prompt(this, message);
  }

  steer(message: unknown): void {
    this.script.steer?.(this, message);
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

/** Creates a `generateAssistantReply` agent factory backed by a scripted fake. */
export function createScriptedReplyAgentFactory(
  script: ScriptedReplyAgentScript,
) {
  return (options: ScriptedReplyAgentOptions) =>
    new TestReplyAgent(options, script);
}
