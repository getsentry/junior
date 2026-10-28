import { TranscriptSubagentView } from "../../conversations/TranscriptSubagentView";
import { TranscriptToolView } from "../../conversations/TranscriptToolView";
import type {
  TranscriptViewSubagentPart,
  TranscriptViewToolCallPart,
} from "../../types";

type ToolCallFixture = {
  description: string;
  part: TranscriptViewToolCallPart;
  timestamp: number;
};

const TOOL_CALL_TIMESTAMP = Date.UTC(2026, 4, 1, 16);

const TOOL_CALL_FIXTURES = [
  {
    description: "Default completed tool with normalized arguments",
    part: {
      id: "gallery-search",
      input: {
        query: "release regression",
        limit: 25,
        options: { includeArchived: false },
      },
      name: "searchIssues",
      output: { matches: 3 },
      resultTimestamp: TOOL_CALL_TIMESTAMP + 1_842,
      status: "completed",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP,
  },
  {
    description: "Running webSearch with name-only shimmer",
    part: {
      id: "gallery-running",
      input: {
        query: "service:checkout status:error",
        max_results: 50,
      },
      name: "webSearch",
      status: "running",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 3_000,
  },
  {
    description: "Failed tool",
    part: {
      id: "gallery-error",
      input: {
        command: "jr-rpc config get github.repo",
        timeout_ms: 10_000,
      },
      name: "bash",
      output: { error: "configuration unavailable" },
      resultTimestamp: TOOL_CALL_TIMESTAMP + 6_416,
      status: "error",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 6_000,
  },
  {
    description: "Known loadSkill signature",
    part: {
      id: "gallery-load-skill",
      input: { skill_name: "junior-qa" },
      name: "loadSkill",
      output: { skill_name: "junior-qa" },
      resultTimestamp: TOOL_CALL_TIMESTAMP + 8_105,
      status: "completed",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 8_000,
  },
  {
    description: "Known executeTool signature with nested arguments",
    part: {
      id: "gallery-execute-tool",
      input: {
        tool_name: "github_search",
        arguments: { query: "is:pr is:open", limit: 25 },
      },
      name: "executeTool",
      output: { matches: 3 },
      resultTimestamp: TOOL_CALL_TIMESTAMP + 10_723,
      status: "completed",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 10_000,
  },
  {
    description: "Long generic arguments exercise both truncation limits",
    part: {
      id: "gallery-long",
      input: {
        project: "payments-checkout-platform",
        query:
          "Find every regression associated with the most recent production deployment and include the complete evidence trail",
        environment: "production",
        includeResolved: false,
        ignoredAfterFourEntries: "not shown in the collapsed preview",
      },
      name: "investigateDeploy",
      output: { channel_id: "C123" },
      resultTimestamp: TOOL_CALL_TIMESTAMP + 13_250,
      status: "completed",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 12_000,
  },
  {
    description: "Completed tool without argument or result payloads",
    part: {
      id: "gallery-empty",
      name: "systemTime",
      status: "completed",
      type: "tool_call",
    },
    timestamp: TOOL_CALL_TIMESTAMP + 15_000,
  },
] as const satisfies readonly ToolCallFixture[];

const SUBAGENT_STARTED = Date.UTC(2026, 4, 1, 16);

const SUBAGENT_FIXTURES: readonly TranscriptViewSubagentPart[] = [
  {
    agentName: "planner",
    childConversationId: "gallery-planner",
    id: "gallery-planner",
    status: "running",
    subagentKind: "agent",
    type: "subagent",
    title: "Review the dashboard plan",
  },
  {
    agentName: "reviewer",
    childConversationId: "gallery-reviewer",
    finishedTimestamp: SUBAGENT_STARTED + 16_000,
    id: "gallery-reviewer",
    status: "completed",
    subagentKind: "agent",
    type: "subagent",
    title: "Check the pull request against the repository rules",
  },
  {
    agentName: "github",
    childConversationId: "gallery-github",
    finishedTimestamp: SUBAGENT_STARTED + 4_000,
    id: "gallery-github",
    status: "blocked",
    subagentKind: "agent",
    type: "subagent",
  },
  {
    agentName: "deploy",
    childConversationId: "gallery-deploy",
    finishedTimestamp: SUBAGENT_STARTED + 92_000,
    id: "gallery-deploy",
    status: "error",
    subagentKind: "agent",
    type: "subagent",
    task: "Roll back payments-v42 in us-west1 and confirm the canary error rate.",
  },
];

/** Render typed transcript tool states for visual regression and interaction checks. */
export function ToolCallGallery() {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-dashboard-border bg-dashboard-fill-faint">
      <div className="border-b border-dashboard-border-subtle px-2.5 py-1.5 font-sans text-xs text-dashboard-text-muted">
        Activity lane · click a row for arguments and result
      </div>
      <div className="grid min-w-0 gap-1 px-2 py-1.5">
        {TOOL_CALL_FIXTURES.map((fixture) => (
          <div className="grid min-w-0 gap-1" key={fixture.part.id}>
            <div className="font-sans font-medium text-2xs text-dashboard-text-muted">
              {fixture.description}
            </div>
            <TranscriptToolView
              part={fixture.part}
              timestamp={fixture.timestamp}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Show subagent cards in each lifecycle status, with and without a title. */
export function SubagentCardFixture() {
  return (
    <div className="grid min-w-0 gap-2">
      {SUBAGENT_FIXTURES.map((part) => (
        <TranscriptSubagentView
          key={part.id}
          onOpenTranscript={() => undefined}
          part={part}
          timestamp={SUBAGENT_STARTED}
        />
      ))}
    </div>
  );
}
