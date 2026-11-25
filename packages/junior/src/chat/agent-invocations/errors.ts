/** A child agent already uses this name in the parent Conversation. */
export class AgentNameInUseError extends Error {
  constructor(name: string) {
    super(`A child agent named "${name}" already exists`);
    this.name = "AgentNameInUseError";
  }
}

/** Parent already has the maximum number of active child agents. */
export class AgentInvocationLimitError extends Error {
  constructor(limit: number) {
    super(`Parent already has ${limit} active child agents (limit ${limit})`);
    this.name = "AgentInvocationLimitError";
  }
}

/**
 * The Conversation that calls startAgent is too deep to start child agents,
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

/** A stopped Conversation cannot give work to child agents. */
export class AgentStoppedError extends Error {
  constructor() {
    super(
      "This conversation is stopped, so it cannot give work to child agents",
    );
    this.name = "AgentStoppedError";
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
