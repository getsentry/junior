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

/** A child agent already has the maximum number of open tasks. */
export class AgentMessageQueueFullError extends Error {
  constructor(limit: number) {
    super(`The child agent already has ${limit} open tasks`);
    this.name = "AgentMessageQueueFullError";
  }
}

/** A messageAgent target is not the parent or a child of the sender. */
export class AgentMessageTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentMessageTargetError";
  }
}
