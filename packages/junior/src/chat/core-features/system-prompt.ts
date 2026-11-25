/**
 * The system prompt rules of core features, which core places at fixed
 * sites. Core reads them here, so it imports no feature. It holds only
 * static text, so the system prompt rules stay a leaf module.
 */
import type { ToolPolicySection } from "@/chat/system-prompt-rules";
import {
  TODO_CHILD_AGENT_RUN_RULES,
  TODO_POLICY_SECTION,
  TODO_TASK_EXECUTION_RULES,
} from "@/chat/todos/prompt-rules";

/** The block 5 section after `<skill-policy>`. */
export const CORE_FEATURE_TOOL_POLICY_SECTION: ToolPolicySection =
  TODO_POLICY_SECTION;

/** Lines of block 2 `<child-agent-run>`, before the input rules. */
export const CORE_FEATURE_CHILD_AGENT_RUN_RULES: readonly string[] =
  TODO_CHILD_AGENT_RUN_RULES;

/** The last lines of block 2 `<task-execution>`. */
export const CORE_FEATURE_TASK_EXECUTION_RULES: readonly string[] =
  TODO_TASK_EXECUTION_RULES;
