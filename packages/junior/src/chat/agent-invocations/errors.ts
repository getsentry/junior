/** A child agent already uses this name in the parent Conversation. */
export class AgentNameInUseError extends Error {
  constructor(name: string) {
    super(`A child agent named "${name}" already exists`);
    this.name = "AgentNameInUseError";
  }
}

/** Parent already has the maximum number of non-terminal child invocations. */
export class AgentInvocationLimitError extends Error {
  constructor(limit: number) {
    super(
      `Parent already has ${limit} active child agent invocations (limit ${limit})`,
    );
    this.name = "AgentInvocationLimitError";
  }
}

/**
 * The Conversation that calls spawnAgent is too deep to start child agents,
 * or its parent chain does not end at a root.
 */
export class AgentDepthLimitError extends Error {
  constructor(maxAgentDepth: number) {
    super(
      `This agent cannot start child agents: only ${maxAgentDepth} level(s) of child agents can start their own`,
    );
    this.name = "AgentDepthLimitError";
  }
}

/** A child agent already has the maximum number of open tasks. */
export class AgentMessageQueueFullError extends Error {
  constructor(limit: number) {
    super(`The child agent already has ${limit} open tasks`);
    this.name = "AgentMessageQueueFullError";
  }
}

/**
 * A messageAgent target is not the parent, a child, or a top-level agent that
 * the sender can message.
 */
export class AgentMessageTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentMessageTargetError";
  }
}

/** A top-level agent paused automated Turns, so it takes no agent message. */
export class AgentMessagePausedError extends Error {
  constructor(conversationId: string) {
    super(
      `${conversationId} paused automated work until a person replies there`,
    );
    this.name = "AgentMessagePausedError";
  }
}
