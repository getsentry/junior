import type {
  ConversationReport as DashboardConversationReport,
  TranscriptMessage as DashboardTranscriptMessage,
} from "@sentry/junior/reporting";

const LONG_CONVERSATION_ID = "slack:CQA456:1770021600.000600";

function iso(nowMs: number, offsetMs = 0): string {
  return new Date(nowMs + offsetMs).toISOString();
}

function sentryConversationUrl(conversationId: string): string {
  return `https://sentry.example.com/organizations/acme/explore/conversations/${encodeURIComponent(conversationId)}/`;
}

function sentryTraceUrl(traceId: string): string {
  return `https://sentry.example.com/performance/trace/${traceId}/`;
}

function mockSystemPrompt(): string {
  return [
    "You are Junior, a Slack-native helper for engineering workflows.",
    "",
    "# Operating Contract",
    "",
    "- Lead with the answer, then support it with evidence.",
    "- Use available tools for repository, build, and deployment checks.",
    "- Keep progress updates short when the work takes multiple steps.",
    "- Do not expose secrets, private channel contents, or raw provider credentials.",
    "- Verify package changes with install, check, typecheck, and build where possible.",
    "- When a check fails, preserve the exact failure in the final summary.",
    "",
    "# Repository Defaults",
    "",
    "- Default application repo: acme/junior-demo.",
    "- Default package namespace: @acme/junior.",
    "- Open pull requests as drafts unless the requester asks for ready review.",
    "",
    "# Slack Output",
    "",
    "- Be concise.",
    "- Prefer bullets for multi-step engineering results.",
    "- Include the PR link when one was created.",
  ].join("\n");
}

function bashOutput(
  command: string,
  stdout: string,
  options?: {
    durationMs?: number;
    exitCode?: number;
    stderr?: string;
    timedOut?: boolean;
  },
): string {
  const exitCode = options?.exitCode ?? 0;
  return JSON.stringify({
    ok: exitCode === 0 && !options?.timedOut,
    command,
    cwd: "/vercel/sandbox",
    exit_code: exitCode,
    signal: null,
    timed_out: options?.timedOut ?? false,
    stdout,
    stderr: options?.stderr ?? "",
    stdout_truncated: false,
    stderr_truncated: false,
  });
}

function toolCall(
  startedAtMs: number,
  offsetMs: number,
  id: string,
  name: string,
  input: unknown,
): DashboardTranscriptMessage {
  return {
    role: "assistant",
    timestamp: startedAtMs + offsetMs,
    parts: [
      {
        id,
        input,
        name,
        type: "tool_call",
      },
    ],
  };
}

function toolResult(
  startedAtMs: number,
  offsetMs: number,
  id: string,
  name: string,
  output: unknown,
): DashboardTranscriptMessage {
  return {
    role: "toolResult",
    timestamp: startedAtMs + offsetMs,
    parts: [
      {
        id,
        name,
        output,
        type: "tool_result",
      },
    ],
  };
}

function bashPair(
  startedAtMs: number,
  index: number,
  offsetMs: number,
  command: string,
  stdout: string,
  options?: {
    durationMs?: number;
    exitCode?: number;
    stderr?: string;
    timedOut?: boolean;
  },
): DashboardTranscriptMessage[] {
  const id = `toolu_mock_release_bash_${index}`;
  const durationMs = options?.durationMs ?? 900 + ((index * 977) % 4200);
  return [
    toolCall(startedAtMs, offsetMs, id, "bash", {
      command,
      ...(options?.timedOut ? { timeoutMs: 120_000 } : {}),
    }),
    toolResult(
      startedAtMs,
      offsetMs + durationMs,
      id,
      "bash",
      bashOutput(command, stdout, options),
    ),
  ];
}

function progressPair(
  startedAtMs: number,
  index: number,
  offsetMs: number,
  message: string,
): DashboardTranscriptMessage[] {
  const id = `toolu_mock_release_progress_${index}`;
  return [
    toolCall(startedAtMs, offsetMs, id, "reportProgress", { message }),
    toolResult(startedAtMs, offsetMs + 500, id, "reportProgress", "ok"),
  ];
}

function releaseTranscriptTurnOne(
  startedAtMs: number,
): DashboardTranscriptMessage[] {
  return [
    {
      role: "system",
      timestamp: startedAtMs,
      parts: [{ type: "text", text: mockSystemPrompt() }],
    },
    {
      role: "user",
      timestamp: startedAtMs + 1_000,
      parts: [
        {
          type: "text",
          text: "minor bump junior",
        },
        {
          type: "text",
          text: "please publish the package bump and open a self-update PR in the app repo once it is ready.",
        },
      ],
    },
    {
      role: "assistant",
      timestamp: startedAtMs + 6_000,
      parts: [
        {
          type: "thinking",
          output:
            "This is release work, so I need to inspect package versions first, publish, then update the app configuration repo.",
        },
        {
          id: "toolu_mock_release_skill_0",
          input: { skill: "release-package" },
          name: "loadSkill",
          type: "tool_call",
        },
      ],
    },
    toolResult(
      startedAtMs,
      7_100,
      "toolu_mock_release_skill_0",
      "loadSkill",
      [
        "Loaded skill: release-package",
        "",
        "Verify workspace package versions, run release checks, and publish with the package manager.",
      ].join("\n"),
    ),
    ...progressPair(startedAtMs, 0, 9_000, "Checking package versions"),
    ...bashPair(
      startedAtMs,
      0,
      12_000,
      "pnpm view @acme/junior version",
      "0.62.0\n",
    ),
    ...bashPair(
      startedAtMs,
      1,
      16_000,
      "pnpm version --recursive minor --no-git-tag-version",
      [
        "@acme/junior 0.63.0",
        "@acme/junior-dashboard 0.63.0",
        "@acme/junior-github 0.63.0",
        "@acme/junior-scheduler 0.63.0",
      ].join("\n") + "\n",
      { durationMs: 2_700 },
    ),
    ...progressPair(startedAtMs, 1, 22_000, "Running release checks"),
    ...bashPair(
      startedAtMs,
      2,
      26_000,
      "pnpm release:check",
      [
        "Checking release package manifests...",
        "✓ package versions aligned",
        "✓ changelog entries present",
        "✓ dist tags ready",
      ].join("\n") + "\n",
      { durationMs: 4_800 },
    ),
    ...bashPair(
      startedAtMs,
      3,
      34_000,
      "pnpm publish -r --tag latest",
      [
        "Publishing packages:",
        "+ @acme/junior@0.63.0",
        "+ @acme/junior-dashboard@0.63.0",
        "+ @acme/junior-github@0.63.0",
        "+ @acme/junior-scheduler@0.63.0",
        "Done in 12.4s.",
      ].join("\n") + "\n",
      { durationMs: 10_900 },
    ),
    {
      role: "assistant",
      timestamp: startedAtMs + 46_000,
      parts: [
        {
          type: "text",
          text: "published `@acme/junior@0.63.0`. moving on to the self-update PR.",
        },
      ],
    },
  ];
}

function releaseTranscriptTurnTwo(
  startedAtMs: number,
): DashboardTranscriptMessage[] {
  return [
    {
      role: "user",
      timestamp: startedAtMs + 1_000,
      parts: [
        {
          type: "text",
          text: "continue with the self-update app PR for the 0.63.0 package set.",
        },
      ],
    },
    {
      role: "assistant",
      timestamp: startedAtMs + 7_000,
      parts: [
        {
          type: "thinking",
          output:
            "I need to clone the app repo, update every @acme/junior package to the same version, run checks, and create a draft PR.",
        },
        {
          id: "toolu_mock_release_skill_1",
          input: { skill: "self-update" },
          name: "loadSkill",
          type: "tool_call",
        },
      ],
    },
    toolResult(
      startedAtMs,
      8_000,
      "toolu_mock_release_skill_1",
      "loadSkill",
      [
        "Loaded skill: self-update",
        "",
        "Use repository-native commands.",
        "Check package manifests and lockfiles before editing.",
        "Prefer a draft PR when publishing dependency bumps.",
      ].join("\n"),
    ),
    ...progressPair(startedAtMs, 2, 12_000, "Cloning app repo"),
    ...bashPair(
      startedAtMs,
      4,
      15_000,
      "git clone https://github.com/acme/junior-demo.git /tmp/junior-demo",
      "Cloning into '/tmp/junior-demo'...\n",
      { durationMs: 3_300 },
    ),
    ...bashPair(
      startedAtMs,
      5,
      19_000,
      "cd /tmp/junior-demo && jq '.dependencies | keys[]' package.json",
      [
        '"@acme/junior"',
        '"@acme/junior-agent-browser"',
        '"@acme/junior-dashboard"',
        '"@acme/junior-github"',
        '"@acme/junior-scheduler"',
      ].join("\n") + "\n",
    ),
    ...bashPair(
      startedAtMs,
      6,
      24_000,
      "cd /tmp/junior-demo && git checkout -b build/update-junior-0.63.0",
      "Switched to a new branch 'build/update-junior-0.63.0'\n",
    ),
    ...progressPair(startedAtMs, 3, 28_000, "Updating dependencies"),
    ...bashPair(
      startedAtMs,
      7,
      32_000,
      "cd /tmp/junior-demo && pnpm add -E @acme/junior@0.63.0 @acme/junior-dashboard@0.63.0 @acme/junior-github@0.63.0 @acme/junior-scheduler@0.63.0",
      [
        "Progress: resolved 1, reused 0, downloaded 0, added 0",
        "Progress: resolved 63, reused 0, downloaded 48, added 0",
        "Progress: resolved 184, reused 0, downloaded 139, added 0",
        "Progress: resolved 312, reused 0, downloaded 240, added 0",
        "Progress: resolved 628, reused 0, downloaded 552, added 0",
        "Packages: +673",
        "++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++",
        "dependencies:",
        "+ @acme/junior 0.63.0",
        "+ @acme/junior-dashboard 0.63.0",
        "+ @acme/junior-github 0.63.0",
        "+ @acme/junior-scheduler 0.63.0",
        "",
        "Ignored build scripts: native-compression@1.0.0, protobufjs@7.5.5.",
        "Done in 16.8s using pnpm v10.34.1",
      ].join("\n") + "\n",
      { durationMs: 16_800, timedOut: false },
    ),
    {
      role: "assistant",
      timestamp: startedAtMs + 58_000,
      parts: [
        {
          type: "thinking",
          output:
            "The package install completed and updated the lockfile. Next I should run the app-specific registration check before broader checks.",
        },
        {
          type: "text",
          text: "dependencies updated; checking app package registration now.",
        },
      ],
    },
    ...bashPair(
      startedAtMs,
      8,
      64_000,
      "cd /tmp/junior-demo && node scripts/check-plugin-packages.mjs",
      "✓ All @acme/junior-* plugin packages are registered in nitro.config.ts\n",
      { durationMs: 2_300 },
    ),
    ...bashPair(
      startedAtMs,
      9,
      69_000,
      "cd /tmp/junior-demo && git diff --name-only",
      "package.json\npnpm-lock.yaml\n",
    ),
    ...progressPair(startedAtMs, 4, 73_000, "Running checks"),
    ...bashPair(
      startedAtMs,
      10,
      78_000,
      "cd /tmp/junior-demo && pnpm check",
      [
        "> @acme/junior-demo@0.1.0 check /tmp/junior-demo",
        "> node scripts/check-plugin-packages.mjs && junior check",
        "",
        "✓ app files",
        "✓ plugin github-repo",
        "✓ packaged plugin agent-browser (@acme/junior-agent-browser)",
        "✓ packaged plugin github (@acme/junior-github)",
        "✓ packaged plugin scheduler (@acme/junior-scheduler)",
        "✓ Validation passed (7 plugin manifests, 14 skill directories checked).",
      ].join("\n") + "\n",
      { durationMs: 9_400 },
    ),
    ...bashPair(
      startedAtMs,
      11,
      93_000,
      "cd /tmp/junior-demo && pnpm typecheck",
      "> @acme/junior-demo@0.1.0 typecheck /tmp/junior-demo\n> tsc --noEmit\n\n",
      { durationMs: 4_100 },
    ),
    {
      role: "assistant",
      timestamp: startedAtMs + 104_000,
      parts: [
        {
          type: "thinking",
          output:
            "Check and typecheck are green. Build may need runtime secrets; if so, capture the exact failure and continue with a draft PR.",
        },
        {
          type: "text",
          text: "check + typecheck are green. trying build next.",
        },
      ],
    },
    ...bashPair(
      startedAtMs,
      12,
      110_000,
      "cd /tmp/junior-demo && pnpm build",
      [
        "> @acme/junior-demo@0.1.0 build /tmp/junior-demo",
        "> nitro build",
        "",
        "Loaded plugins (2): github-repo, devinfra-docs",
        "Resolving sandbox snapshot profile...",
        "junior command failed: CACHE_URL is required for durable thread state",
      ].join("\n") + "\n",
      { durationMs: 7_300, exitCode: 1 },
    ),
    {
      role: "assistant",
      timestamp: startedAtMs + 126_000,
      parts: [
        {
          type: "thinking",
          output:
            "The build failure is an environment constraint, not a dependency failure. I should include it in the PR body and commit only the package files.",
        },
        {
          type: "text",
          text: "build hit the expected sandbox env wall: `CACHE_URL is required for durable thread state`. committing the package update with that called out.",
        },
      ],
    },
    ...bashPair(
      startedAtMs,
      13,
      132_000,
      'cd /tmp/junior-demo && git add package.json pnpm-lock.yaml && git commit -m "build(deps): update junior packages to 0.63.0"',
      "[build/update-junior-0.63.0 885bf7f] build(deps): update junior packages to 0.63.0\n 2 files changed, 68 insertions(+), 67 deletions(-)\n",
      { durationMs: 2_600 },
    ),
    ...bashPair(
      startedAtMs,
      14,
      142_000,
      "cd /tmp/junior-demo && git push -u origin build/update-junior-0.63.0",
      [
        "remote:",
        "remote: Create a pull request for 'build/update-junior-0.63.0' on GitHub by visiting:",
        "remote:      https://github.com/acme/junior-demo/pull/new/build/update-junior-0.63.0",
        "To https://github.com/acme/junior-demo.git",
        " * [new branch]      build/update-junior-0.63.0 -> build/update-junior-0.63.0",
        "branch 'build/update-junior-0.63.0' set up to track 'origin/build/update-junior-0.63.0'.",
      ].join("\n") + "\n",
      { durationMs: 4_400 },
    ),
    ...bashPair(
      startedAtMs,
      15,
      154_000,
      'cd /tmp/junior-demo && gh pr create --draft --title "build(deps): update junior packages to 0.63.0"',
      "https://github.com/acme/junior-demo/pull/42\n",
      { durationMs: 3_100 },
    ),
    ...progressPair(startedAtMs, 5, 160_000, "Draft PR created"),
    {
      role: "assistant",
      timestamp: startedAtMs + 166_000,
      parts: [
        {
          type: "text",
          text: [
            "done. full recap:",
            "",
            "- **released** `@acme/junior@0.63.0`",
            "- **self-update PR** opened at https://github.com/acme/junior-demo/pull/42",
            "- `pnpm check` and `pnpm typecheck` passed",
            "- `pnpm build` failed on missing `CACHE_URL`, which is a sandbox environment constraint",
          ].join("\n"),
        },
      ],
    },
  ];
}

/** Build a long sanitized release/update transcript for dashboard visual QA. */
export function longReleaseConversation(
  nowMs: number,
): DashboardConversationReport {
  const traceId = "7a4f12c9e3d84901b6c7d8e9f0123456";
  const firstStartedAt = iso(nowMs, -92 * 60_000);
  const secondStartedAt = iso(nowMs, -90 * 60_000);
  const firstTranscript = releaseTranscriptTurnOne(Date.parse(firstStartedAt));
  const secondTranscript = releaseTranscriptTurnTwo(
    Date.parse(secondStartedAt),
  );

  return {
    conversationId: LONG_CONVERSATION_ID,
    displayTitle: "Package release and self-update",
    generatedAt: iso(nowMs),
    runs: [
      {
        conversationId: LONG_CONVERSATION_ID,
        displayTitle: "Package release and self-update",
        id: "mock-release-turn-1",
        status: "completed",
        startedAt: firstStartedAt,
        lastProgressAt: iso(nowMs, -91 * 60_000),
        lastSeenAt: iso(nowMs, -91 * 60_000),
        completedAt: iso(nowMs, -91 * 60_000),
        cumulativeDurationMs: 48_449,
        cumulativeUsage: {
          cachedInputTokens: 167_859,
          cacheCreationTokens: 19_277,
          inputTokens: 13,
          outputTokens: 1037,
        },
        surface: "slack",
        requesterIdentity: {
          fullName: "Jordan Blake",
          slackUserId: "UQA777",
          slackUserName: "jordan",
        },
        channel: "CQA456",
        channelName: "proj-release",
        sentryConversationUrl: sentryConversationUrl(LONG_CONVERSATION_ID),
        sentryTraceUrl: sentryTraceUrl(traceId),
        traceId,
        transcriptAvailable: true,
        transcriptMessageCount: firstTranscript.length,
        transcript: firstTranscript,
      },
      {
        conversationId: LONG_CONVERSATION_ID,
        displayTitle: "Package release and self-update",
        id: "mock-release-turn-2",
        status: "completed",
        startedAt: secondStartedAt,
        lastProgressAt: iso(nowMs, -81 * 60_000),
        lastSeenAt: iso(nowMs, -81 * 60_000),
        completedAt: iso(nowMs, -81 * 60_000),
        cumulativeDurationMs: 552_761,
        cumulativeUsage: {
          cachedInputTokens: 1_266_200,
          cacheCreationTokens: 21_129,
          inputTokens: 43,
          outputTokens: 5765,
        },
        surface: "slack",
        requesterIdentity: {
          fullName: "Jordan Blake",
          slackUserId: "UQA777",
          slackUserName: "jordan",
        },
        channel: "CQA456",
        channelName: "proj-release",
        sentryConversationUrl: sentryConversationUrl(LONG_CONVERSATION_ID),
        sentryTraceUrl: sentryTraceUrl(traceId),
        traceId,
        transcriptAvailable: true,
        transcriptMessageCount: secondTranscript.length,
        transcript: secondTranscript,
      },
    ],
  };
}
