/**
 * Existing files allowed to exceed 1,000 lines.
 *
 * Every entry needs a reason. Remove the entry when the file is split.
 */
export const fileLengthExceptions = {
  "packages/junior-evals/src/behavior-harness.ts":
    "Existing eval harness; split by harness concern.",
  "packages/junior-evals/src/helpers.ts":
    "Existing shared eval helpers; split by helper concern.",
  "packages/junior-dashboard/src/mock-reporting/fixtures.ts":
    "Large static reporting fixture set.",
  "packages/junior-dashboard/tests/telemetry-components.test.tsx":
    "Existing broad telemetry component suite; split by component.",
  "packages/junior-github/tests/github-plugin.test.ts":
    "Existing broad plugin suite; split with plugin modules.",
  "packages/junior-github/tests/webhook-outcomes.test.ts":
    "Existing broad webhook outcome suite; split by outcome.",
  "packages/junior-memory/src/store.ts":
    "Existing memory store; split by storage concern.",
  "packages/junior-memory/tests/storage.test.ts":
    "Existing broad memory storage suite; split by storage concern.",
  "packages/junior/src/chat/scheduled-tasks/store.ts":
    "Existing scheduled-task store; split by storage concern.",
  "packages/junior/src/chat/agent/index.ts":
    "Existing agent run lifecycle; split only at a clear lifecycle boundary.",
  "packages/junior/src/chat/logging.ts":
    "Existing logging module; split console, Sentry, and model usage concerns.",
  "packages/junior/src/chat/plugins/agent-hooks.ts":
    "Existing plugin hook runtime; split by hook phase.",
  "packages/junior/src/chat/plugins/manifest.ts":
    "Existing manifest parser; split parsing from validation.",
  "packages/junior/src/chat/runtime/reply-executor.ts":
    "Existing reply lifecycle; split only at a clear lifecycle boundary.",
  "packages/junior/src/chat/runtime/slack-runtime.ts":
    "Existing Slack runtime; split by runtime phase.",
  "packages/junior/src/chat/state/turn-session.ts":
    "Existing turn session persistence; split by persistence concern.",
  "packages/junior/src/chat/task-execution/state.ts":
    "Existing mailbox and lease store; split without separating shared locks.",
  "packages/junior/src/cli/check.ts":
    "Existing CLI check command; split checks by subject.",
  "packages/junior/tests/component/conversation-sql-store.test.ts":
    "Existing broad conversation SQL suite; split by behavior.",
  "packages/junior/tests/component/conversation-storage-sql.test.ts":
    "Existing broad conversation storage suite; split by behavior.",
  "packages/junior/tests/component/misc/sandbox-executor.test.ts":
    "Existing broad sandbox executor suite; split by behavior.",
  "packages/junior/tests/component/plugins/plugin-registry-packages.test.ts":
    "Existing broad plugin registry suite; split by package behavior.",
  "packages/junior/tests/component/runtime/agent-run-mcp-progressive-loading.test.ts":
    "Existing broad MCP loading suite; split by behavior.",
  "packages/junior/tests/component/services/turn-session-record.test.ts":
    "Existing broad turn session record suite; split by behavior.",
  "packages/junior/tests/component/task-execution/conversation-work.test.ts":
    "Existing broad conversation work suite; split by behavior.",
  "packages/junior/tests/component/task-execution/slack-conversation-work.test.ts":
    "Existing broad Slack conversation work suite; split by behavior.",
  "packages/junior/tests/integration/agent-continue-slack.test.ts":
    "Existing broad Slack continuation suite; split by behavior.",
  "packages/junior/tests/integration/local-agent-runner.test.ts":
    "Existing broad local runner suite; split by behavior.",
  "packages/junior/tests/component/auth/mcp-auth-runtime-slack.test.ts":
    "Existing broad MCP auth suite; split by behavior.",
  "packages/junior/tests/component/runtime/agent-run-provider-retry.test.ts":
    "Existing broad provider retry suite; split by behavior.",
  "packages/junior/tests/integration/sandbox-egress-proxy.test.ts":
    "Existing broad sandbox egress suite; split by behavior.",
  "packages/junior/tests/integration/slack/bot-handlers.test.ts":
    "Existing broad Slack handler suite; split by handler.",
  "packages/junior/tests/integration/slack-schedule-tools.test.ts":
    "Existing broad Slack scheduler suite; split by tool.",
  "packages/junior/tests/integration/slack/subscribed-message-behavior.test.ts":
    "Existing broad subscribed-message suite; split by behavior.",
  "packages/junior/tests/unit/api/conversation-events.test.ts":
    "Existing broad conversation events suite; split by behavior.",
  "packages/junior/tests/unit/plugins/agent-hooks.test.ts":
    "Existing broad agent hooks suite; split by hook.",
};
