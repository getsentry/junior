/** Named child cannot accept another invocation until its active work ends. */
export class AgentInvocationBusyError extends Error {
  constructor(name: string) {
    super(`Named agent "${name}" already has active work`);
    this.name = "AgentInvocationBusyError";
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
