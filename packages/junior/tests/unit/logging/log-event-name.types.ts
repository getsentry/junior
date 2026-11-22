// Type tests for LogEventName. `pnpm typecheck` compiles this file; nothing
// runs it. An unused `@ts-expect-error` fails the typecheck, so loosening the
// type breaks the build.
import { logException, logInfo } from "@/chat/logging";

declare const kind: "slack" | "github";
declare const runtimeKind: string;
declare const error: unknown;

logInfo("slack.thread.post.completed");
logInfo("soul.loaded");
logInfo("agent.turn.provider.retrying");
logInfo("sandbox.workspace_snapshot.builder.delete_failed");
logException(error, `${kind}.title.generation.failed`);

// @ts-expect-error uppercase
logInfo("Agent.Turn.Failed");
// @ts-expect-error dash
logInfo("agent.turn-limit.failed");
// @ts-expect-error empty segment
logInfo("agent..failed");
// @ts-expect-error single segment
logInfo("heartbeat");
// @ts-expect-error trailing underscore
logInfo("agent.turn_");
// @ts-expect-error base-verb outcome
logInfo("agent.turn.provider.retry");
// @ts-expect-error base-verb suffix outcome
logInfo("agent.turn.no_progress_fail");
// @ts-expect-error direction outcome
logInfo("agent.turn.limit.wrap_up");
// @ts-expect-error string hole
logException(error, `${runtimeKind}.title.generation.failed`);
// @ts-expect-error wide string
logInfo(runtimeKind);
