import {
  getAgentPluginEventDefinitions,
  type RegisteredAgentEventDefinition,
} from "@/chat/plugins/agent-hooks";
import {
  discoverEventBindingFiles,
  parseAndValidateEventBindingFiles,
  type ParsedEventBinding,
} from "@/chat/events/bindings";
import { getBuiltinEventDefinitions } from "@/chat/events/slack";

let definitions: RegisteredAgentEventDefinition[] = [];
let bindings: ParsedEventBinding[] = [];

function validateDefinitions(
  nextDefinitions: RegisteredAgentEventDefinition[],
): void {
  const seen = new Map<string, string>();
  for (const definition of nextDefinitions) {
    const existing = seen.get(definition.event);
    if (existing) {
      throw new Error(
        `Duplicate event definition "${definition.event}" from "${definition.plugin}" already declared by "${existing}"`,
      );
    }
    seen.set(definition.event, definition.plugin);
  }
}

/** Return built-in and trusted-plugin event definitions. */
export function getAvailableEventDefinitions(): RegisteredAgentEventDefinition[] {
  const nextDefinitions = [
    ...getBuiltinEventDefinitions(),
    ...getAgentPluginEventDefinitions(),
  ];
  validateDefinitions(nextDefinitions);
  return nextDefinitions;
}

/** Load install-owned event prompt bindings and fail before partial registration. */
export async function loadEventPromptRegistry(
  installRoot: string = process.cwd(),
): Promise<void> {
  const nextDefinitions = getAvailableEventDefinitions();
  const files = await discoverEventBindingFiles(installRoot);
  const result = parseAndValidateEventBindingFiles(files, nextDefinitions);
  if (result.errors.length > 0) {
    throw new Error(
      `Invalid event prompt bindings:\n${result.errors.join("\n")}`,
    );
  }
  definitions = nextDefinitions;
  bindings = result.bindings;
}

/** Return event definitions from the last successful registry load. */
export function getLoadedEventDefinitions(): RegisteredAgentEventDefinition[] {
  return [...definitions];
}

/** Return install-owned event bindings from the last successful registry load. */
export function getLoadedEventBindings(): ParsedEventBinding[] {
  return [...bindings];
}
