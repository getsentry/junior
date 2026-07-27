/** Named child cannot accept another invocation until its active work ends. */
export class AgentInvocationBusyError extends Error {
  constructor(name: string) {
    super(`Named agent "${name}" already has active work`);
    this.name = "AgentInvocationBusyError";
  }
}
