import fs from "node:fs";
import path from "node:path";
import { botConfig, getRuntimeMetadata } from "@/chat/config";
import {
  listReferenceFiles,
  soulPathCandidates,
  worldPathCandidates,
} from "@/chat/discovery";
import { logInfo, logWarn } from "@/chat/logging";
import { getPluginProviders } from "@/chat/plugins/registry";
import { slackOutputPolicy } from "@/chat/slack/output";
import {
  SANDBOX_DATA_ROOT,
  SANDBOX_WORKSPACE_ROOT,
  sandboxSkillDir,
} from "@/chat/sandbox/paths";
import type { ThreadArtifactsState } from "@/chat/state/artifacts";
import type { Skill, SkillMetadata, SkillInvocation } from "@/chat/skills";
import type { ActiveMcpCatalogSummary } from "@/chat/tools/skill/mcp-tool-summary";
import { escapeXml } from "@/chat/xml";

const DEFAULT_SOUL = "You are Junior, a practical and concise assistant.";

function getLoggedMarkdownFiles(): Set<string> {
  const globalState = globalThis as typeof globalThis & {
    __juniorLoggedMarkdownFiles?: Set<string>;
  };
  globalState.__juniorLoggedMarkdownFiles ??= new Set<string>();
  return globalState.__juniorLoggedMarkdownFiles;
}

function loadOptionalMarkdownFile(
  candidates: string[],
  fileName: string,
): string | null {
  for (const resolved of candidates) {
    try {
      const raw = fs.readFileSync(resolved, "utf8").trim();
      if (raw.length > 0) {
        const loggedMarkdownFiles = getLoggedMarkdownFiles();
        const logKey = `${fileName}:${resolved}`;
        if (!loggedMarkdownFiles.has(logKey)) {
          loggedMarkdownFiles.add(logKey);
          logInfo(
            `${fileName.toLowerCase()}_loaded`,
            {},
            {
              "file.path": resolved,
            },
            `Loaded ${fileName}`,
          );
        }
        return raw;
      }
    } catch {
      continue;
    }
  }

  return null;
}

function loadSoul(): string {
  const soul = loadOptionalMarkdownFile(soulPathCandidates(), "SOUL.md");
  if (soul) {
    return soul;
  }

  logWarn(
    "soul_load_fallback",
    {},
    {
      "app.file.candidates": soulPathCandidates(),
    },
    "SOUL.md not found; using built-in default personality",
  );
  return DEFAULT_SOUL;
}

function loadWorld(): string | null {
  return loadOptionalMarkdownFile(worldPathCandidates(), "WORLD.md");
}

export const JUNIOR_PERSONALITY = (() => {
  try {
    return loadSoul();
  } catch (error) {
    logWarn(
      "soul_load_failed",
      {},
      {
        "exception.message":
          error instanceof Error ? error.message : String(error),
      },
      "Failed to load SOUL.md; using built-in default personality",
    );
    return DEFAULT_SOUL;
  }
})();

export const JUNIOR_WORLD = (() => {
  try {
    return loadWorld();
  } catch (error) {
    logWarn(
      "world_load_failed",
      {},
      {
        "exception.message":
          error instanceof Error ? error.message : String(error),
      },
      "Failed to load WORLD.md; omitting world prompt context",
    );
    return null;
  }
})();

function workspaceSkillDir(skillName: string): string {
  return sandboxSkillDir(skillName);
}

function formatConfigurationValue(value: unknown): string {
  if (typeof value === "string") {
    return escapeXml(value);
  }

  try {
    return escapeXml(JSON.stringify(value));
  } catch {
    return escapeXml(String(value));
  }
}

function renderRequesterBlock(
  fields: Record<string, string | undefined>,
): string[] | null {
  const lines = Object.entries(fields)
    .filter(([, value]) => Boolean(value))
    .map(([key, value]) => `- ${key}: ${escapeXml(value as string)}`);

  if (lines.length === 0) {
    return null;
  }

  return ["<requester>", ...lines, "</requester>"];
}

function renderTag(tag: string, lines: string[]): string[] {
  return [`<${tag}>`, ...lines, `</${tag}>`];
}

function renderTagBlock(tag: string, content: string): string {
  return [`<${tag}>`, content, `</${tag}>`].join("\n");
}

function formatAvailableSkillsForPrompt(skills: SkillMetadata[]): string {
  if (skills.length === 0) {
    return "<available-skills>\n</available-skills>";
  }

  const lines = ["<available-skills>"];
  for (const skill of skills) {
    const skillLocation = `${workspaceSkillDir(skill.name)}/SKILL.md`;
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(skill.name)}</name>`);
    lines.push(
      `    <description>${escapeXml(skill.description)}</description>`,
    );
    lines.push(`    <location>${escapeXml(skillLocation)}</location>`);
    if (skill.pluginProvider) {
      lines.push(`    <provider>${escapeXml(skill.pluginProvider)}</provider>`);
    }
    lines.push("  </skill>");
  }
  lines.push("</available-skills>");
  return lines.join("\n");
}

function formatLoadedSkillsForPrompt(skills: Skill[]): string {
  if (skills.length === 0) {
    return "<loaded-skills>\n</loaded-skills>";
  }

  const lines = ["<loaded-skills>"];
  for (const skill of skills) {
    const skillDir = workspaceSkillDir(skill.name);
    lines.push(
      `  <skill name="${escapeXml(skill.name)}" location="${escapeXml(`${skillDir}/SKILL.md`)}">`,
    );
    lines.push(
      `Skill directory: ${escapeXml(skillDir)}. Resolve relative paths there; for skill-owned bash commands, cd there first or use absolute paths.`,
    );
    lines.push("");
    lines.push(skill.body);
    lines.push("  </skill>");
  }
  lines.push("</loaded-skills>");
  return lines.join("\n");
}

function formatProviderCatalogForPrompt(): string | null {
  const providers = getPluginProviders().map((plugin) => plugin.manifest);
  if (providers.length === 0) {
    return null;
  }

  const lines = [
    "Config keys and default targets per provider; use after a skill is loaded.",
  ];
  for (const provider of providers) {
    lines.push(`- provider: ${escapeXml(provider.name)}`);
    lines.push(
      `  - config_keys: ${
        provider.configKeys.length > 0
          ? escapeXml(provider.configKeys.join(", "))
          : "none"
      }`,
    );
    lines.push(
      `  - default_context: ${
        provider.target
          ? escapeXml(
              `${provider.target.type} via ${provider.target.configKey}`,
            )
          : "none"
      }`,
    );
  }
  return lines.join("\n");
}

function formatActiveMcpCatalogsForPrompt(
  catalogs: ActiveMcpCatalogSummary[],
): string | null {
  if (catalogs.length === 0) {
    return null;
  }

  const lines = [
    "Active MCP provider catalogs are available through `searchMcpTools`. Call it with provider to list descriptors or with query to narrow results, then pass the exact returned `tool_name` to `callMcpTool`.",
  ];
  for (const catalog of catalogs) {
    lines.push("  <catalog>");
    lines.push(`    <provider>${escapeXml(catalog.provider)}</provider>`);
    lines.push(
      `    <available_tool_count>${catalog.available_tool_count}</available_tool_count>`,
    );
    lines.push("  </catalog>");
  }
  return lines.join("\n");
}

interface ToolPromptContext {
  name: string;
  promptGuidelines?: string[];
  promptSnippet?: string;
}

function formatToolGuidanceForPrompt(
  tools: ToolPromptContext[],
): string | null {
  const guidedTools = tools.filter(
    (tool) =>
      Boolean(tool.promptSnippet?.trim()) ||
      (tool.promptGuidelines?.length ?? 0) > 0,
  );
  if (guidedTools.length === 0) {
    return null;
  }

  const lines: string[] = [];
  for (const tool of guidedTools) {
    lines.push(`  <tool name="${escapeXml(tool.name)}">`);
    if (tool.promptSnippet?.trim()) {
      lines.push(`    - ${escapeXml(tool.promptSnippet.trim())}`);
    }
    if (tool.promptGuidelines && tool.promptGuidelines.length > 0) {
      for (const guideline of tool.promptGuidelines) {
        lines.push(`    - ${escapeXml(guideline)}`);
      }
    }
    lines.push("  </tool>");
  }
  return lines.join("\n");
}

function formatReferenceFilesLines(): string[] | null {
  const files = listReferenceFiles();
  if (files.length === 0) {
    return null;
  }

  return files.map((filePath) => {
    const name = path.basename(filePath);
    return `- ${escapeXml(name)} (${escapeXml(`${SANDBOX_DATA_ROOT}/${name}`)})`;
  });
}

function formatArtifactsLines(
  artifactState: ThreadArtifactsState | undefined,
): string[] | null {
  if (!artifactState) return null;
  const lines: string[] = [];
  if (artifactState.lastCanvasId) {
    lines.push(`- last_canvas_id: ${escapeXml(artifactState.lastCanvasId)}`);
  }
  if (artifactState.lastCanvasUrl) {
    lines.push(`- last_canvas_url: ${escapeXml(artifactState.lastCanvasUrl)}`);
  }
  if (artifactState.recentCanvases && artifactState.recentCanvases.length > 0) {
    lines.push("- recent_canvases:");
    for (const canvas of artifactState.recentCanvases) {
      lines.push(`  - id: ${escapeXml(canvas.id)}`);
      if (canvas.title) lines.push(`    title: ${escapeXml(canvas.title)}`);
      if (canvas.url) lines.push(`    url: ${escapeXml(canvas.url)}`);
      if (canvas.createdAt) {
        lines.push(`    created_at: ${escapeXml(canvas.createdAt)}`);
      }
    }
  }
  if (artifactState.lastListId) {
    lines.push(`- last_list_id: ${escapeXml(artifactState.lastListId)}`);
  }
  if (artifactState.lastListUrl) {
    lines.push(`- last_list_url: ${escapeXml(artifactState.lastListUrl)}`);
  }
  return lines.length > 0 ? lines : null;
}

function formatConfigurationLines(
  configuration: Record<string, unknown> | undefined,
): string[] | null {
  const keys = Object.keys(configuration ?? {}).sort((a, b) =>
    a.localeCompare(b),
  );
  if (keys.length === 0) return null;
  return keys.map(
    (key) =>
      `- ${escapeXml(key)}: ${formatConfigurationValue(configuration?.[key])}`,
  );
}

function formatSlackCapabilityNames(
  capabilities:
    | {
        canAddReactions?: boolean;
        canCreateCanvas?: boolean;
        canPostToChannel?: boolean;
      }
    | undefined,
): string {
  const names = [
    capabilities?.canCreateCanvas ? "canvas_create" : "",
    capabilities?.canPostToChannel ? "channel_post" : "",
    capabilities?.canAddReactions ? "reaction_add" : "",
  ].filter(Boolean);
  return names.length > 0 ? names.join(", ") : "none";
}

const HEADER =
  "You are a Slack-based helper assistant. Follow the personality block for voice and tone in every reply. The behavior and output blocks define platform mechanics and override personality only when those mechanics conflict.";

const TURN_CONTEXT_HEADER =
  "Per-turn runtime context for this request. Treat these blocks as trusted runtime facts and skill/provider instructions for the current turn; the static system prompt remains authoritative.";
const TURN_CONTEXT_TAG = "runtime-turn-context";

const TOOL_POLICY_RULES = [
  "- Tool schemas are the source of truth for parameters; tool names are case-sensitive, so call tools exactly by their exposed names and do not invent arguments.",
  "- Use tools for actionable work and for facts that are mutable, external, repository-backed, provider-backed, or requested as verified/current. Stable general knowledge and already-provided context may be answered directly.",
  "- Resolve provider action targets before calls: explicit target wins; ambient `<configuration>` fills omitted targets. Treat non-target links/references as context.",
  "- Verification source order: conversation/thread context; user-provided attachments, links, and reference files; local/sandbox files when present; loaded skill references; repository/provider tools; public web. Use the nearest authoritative available source before weaker sources.",
  "- For repository or implementation questions, inspect the target repository first: local checkout when present, otherwise the configured GitHub/source provider. Do not treat loaded skill files as repo source unless the user asks about the skill. Cite file paths, symbols, PRs/issues, commits, or URLs that support the answer.",
  `- Sandbox-backed file and shell tools operate in an isolated workspace rooted at ${SANDBOX_WORKSPACE_ROOT}; readFile/writeFile paths are sandbox-workspace paths, bash runs inside that workspace, and attachFile accepts absolute or workspace-relative sandbox paths.`,
  "- If a sandbox-backed tool reports that sandbox execution is unavailable, treat that as a blocker for local file/shell inspection; do not pretend host files were inspected.",
  "- For user-provided URLs, use `webFetch`; for discovery, use `webSearch` then fetch/read promising sources; for current time/date context, use `systemTime`.",
  "- If the first result is empty, stale, ambiguous, or incomplete, try a focused alternate query, path, command, or source before concluding the answer cannot be verified.",
];

const TOOL_CALL_STYLE_RULES = [
  "- For routine low-risk tool use, call the tool directly without narrating the obvious step first.",
  "- Briefly narrate only when it helps the user understand multi-step work, sensitive actions, destructive actions, or a notable change in approach.",
  "- When a first-class tool exists for an action, use it directly instead of asking the user to run an equivalent command, slash command, or manual lookup.",
  "- Keep tool-call explanations separate from final answers; final answers should report results, evidence, or blockers.",
];

const SKILL_POLICY_RULES = [
  "- Before answering, scan `<available-skills>`. For matching operational or conceptual provider/repository workflow questions, load the most specific skill; do not answer from memory first. If none fits, do not load a skill.",
  "- Never load multiple skills up front. After `loadSkill`, follow `<loaded-skills>` and resolve relative references under that skill's location.",
  "- For explicit `/skill` triggers, treat that skill as selected unless the tool says it is unavailable.",
  "- For active MCP catalogs, use `searchMcpTools` to inspect descriptors before `callMcpTool`; pass exact returned `tool_name` values and put provider fields inside `arguments`.",
  "- Run authenticated provider commands directly after resolving target defaults; let the runtime handle auth pauses/resumes.",
  "- Run `jr-rpc config get|set|unset|list` as standalone bash commands for conversation-scoped provider defaults; do not chain them with `cd`, `&&`, pipes, or provider commands.",
];

const EXECUTION_CONTRACT_RULES = [
  "- Actionable request: act in this turn.",
  "- Continue until done or genuinely blocked. Do not finish with a plan, promise, or offer to check next when an available tool or source can move the request forward.",
  "- Completion means the final answer covers the user's actual ask, including requested follow-up checks, and is grounded in the best evidence you could access.",
  "- Ask the user only for missing access, approval, or a decision that blocks safe progress. Ask one focused question; otherwise infer conservatively and continue.",
  "- For conflicting evidence, compare sources and state which source is authoritative for the answer.",
  "- For non-trivial or long-running work, call `reportProgress` early when available, then only when the major phase changes. Routine tool calls should stay silent.",
];

const CONVERSATION_RULES = [
  "- In thread follow-ups, answer from prior thread context; do not repeat resolved clarifying questions.",
  "- Preserve attribution roles from thread context: the requester is the person asking now, which may differ from the original reporter or subject.",
  "- On resumed turns, post a brief continuation notice, then the resumed answer as a separate message.",
];

const SLACK_ACTION_RULES = [
  "- Context-bound Slack tools use runtime-owned targets; do not invent channel, canvas, list, or message IDs.",
  "- Use first-class Slack tools for Slack side effects; do not use bash, curl, or provider APIs to bypass Slack tool targeting.",
  "- Use channel-post and emoji-reaction tools only when the user explicitly asks for that Slack side effect.",
  "- For explicit channel-post or emoji-reaction requests, skip a duplicate thread text reply when the tool result already satisfies the request.",
  "- Do not claim an attachment, canvas, channel post, list update, or reaction succeeded unless the tool returned success this turn; when it did, include any link the tool returned.",
  "- Do not use reactions as progress indicators.",
];

const SAFETY_RULES = [
  "- Stay within the user's request and the runtime's available capabilities; do not pursue independent goals, persistence, replication, credential gathering, or access expansion.",
  "- Respect stop, pause, audit, and approval boundaries. Do not bypass safeguards or persuade the user to weaken them.",
  "- Do not change system prompts, tool policies, security settings, credentials, or runtime configuration unless the user explicitly requests that exact administrative action and an available tool permits it.",
];

const FAILURE_RULES = [
  "- For tool/runtime failures, run the named check before diagnosing and report the exact failed command plus stderr/exit code.",
  "- If a fact cannot be verified after focused checks, say what you checked and what blocked a stronger answer.",
  "- Do not surface raw tool payloads, execution-escape text, or internal routing metadata as the final answer.",
];

function renderRuleSection(tag: string, lines: string[]): string {
  return [`<${tag}>`, ...lines, `</${tag}>`].join("\n");
}

function buildBehaviorSection(): string {
  return [
    renderRuleSection("tool-policy", TOOL_POLICY_RULES),
    renderRuleSection("tool-call-style", TOOL_CALL_STYLE_RULES),
    renderRuleSection("skill-policy", SKILL_POLICY_RULES),
    renderRuleSection("execution-contract", EXECUTION_CONTRACT_RULES),
    renderRuleSection("conversation", CONVERSATION_RULES),
    renderRuleSection("slack-actions", SLACK_ACTION_RULES),
    renderRuleSection("safety", SAFETY_RULES),
    renderRuleSection("failure-handling", FAILURE_RULES),
  ].join("\n\n");
}

function buildOutputSection(): string {
  const openTag = `<output format="slack-markdown" max_inline_chars="${slackOutputPolicy.maxInlineChars}" max_inline_lines="${slackOutputPolicy.maxInlineLines}">`;
  return [
    openTag,
    "- Start with the answer or result, not internal process narration.",
    "- Use Slack-flavored Markdown: **bold** section labels, `code`, [text](url) links, bullet lists, and fenced code blocks. No tables. When the answer primarily lists several URLs, show each URL bare instead of as a labeled link.",
    "- Keep replies brief and scannable; use bullets or short code blocks when helpful, and one compact thread reply when it fits.",
    "- When a research or document-style answer would benefit from continuation, multiple sections, or future reference value, create a Slack canvas and keep the thread reply to one or two short sentences plus the link; do not recap the canvas contents.",
    "- Unless a successful Slack side-effect tool intentionally satisfied the request by itself, end every turn with a final user-facing markdown response.",
    "</output>",
  ].join("\n");
}

function buildIdentitySection(): string {
  return renderTagBlock(
    "identity",
    `Your Slack username is \`${escapeXml(botConfig.userName)}\`.`,
  );
}

function buildRuntimeSection(params: {
  channelId?: string;
  fastModelId?: string;
  modelId?: string;
  slackCapabilities?: {
    canAddReactions?: boolean;
    canCreateCanvas?: boolean;
    canPostToChannel?: boolean;
  };
  thinkingLevel?: string;
}): string {
  const lines = [
    `- version: ${escapeXml(getRuntimeMetadata().version ?? "unknown")}`,
    params.modelId ? `- model: ${escapeXml(params.modelId)}` : "",
    params.fastModelId ? `- fast_model: ${escapeXml(params.fastModelId)}` : "",
    params.thinkingLevel
      ? `- thinking: ${escapeXml(params.thinkingLevel)}`
      : "",
    params.channelId ? "- channel: slack" : "",
    params.channelId
      ? `- slack_capabilities: ${escapeXml(
          formatSlackCapabilityNames(params.slackCapabilities),
        )}`
      : "",
    `- sandbox_workspace: ${escapeXml(SANDBOX_WORKSPACE_ROOT)}`,
  ].filter(Boolean);

  return renderTagBlock("runtime", lines.join("\n"));
}

function buildContextSection(params: {
  requester?: { userName?: string; fullName?: string; userId?: string };
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  invocation: SkillInvocation | null;
  turnState?: "fresh" | "resumed";
}): string {
  const blocks: string[][] = [];

  if (JUNIOR_WORLD) {
    blocks.push(renderTag("world", [JUNIOR_WORLD.trim()]));
  }

  const referenceLines = formatReferenceFilesLines();
  if (referenceLines) {
    blocks.push(
      renderTag("reference-files", [
        "Additional reference documents available in the sandbox. Read them with `readFile` when relevant.",
        ...referenceLines,
      ]),
    );
  }

  const requesterLines = renderRequesterBlock({
    full_name: params.requester?.fullName,
    user_name: params.requester?.userName,
    user_id: params.requester?.userId,
  });
  if (requesterLines) {
    blocks.push(requesterLines);
  }

  const artifactLines = formatArtifactsLines(params.artifactState);
  if (artifactLines) {
    blocks.push(renderTag("artifacts", artifactLines));
  }

  const configLines = formatConfigurationLines(params.configuration);
  if (configLines) {
    blocks.push(
      renderTag("configuration", [
        "Ambient provider defaults; explicit targets win.",
        ...configLines,
      ]),
    );
  }

  if (params.turnState === "resumed") {
    blocks.push([
      "<turn-state>resumed</turn-state>",
      "This turn continues from a prior checkpoint. Prior tool results and assistant messages are already in the conversation history.",
    ]);
  }

  if (params.invocation) {
    blocks.push([
      `<explicit-skill-trigger>/${escapeXml(params.invocation.skillName)}</explicit-skill-trigger>`,
    ]);
  }

  const body = blocks.map((block) => block.join("\n")).join("\n\n");
  return renderTagBlock("context", body);
}

function buildCapabilitiesSection(params: {
  availableSkills: SkillMetadata[];
  activeSkills: Skill[];
  activeMcpCatalogs: ActiveMcpCatalogSummary[];
  toolGuidance?: ToolPromptContext[];
}): string {
  const blocks: string[] = [];
  blocks.push(formatAvailableSkillsForPrompt(params.availableSkills));
  blocks.push(formatLoadedSkillsForPrompt(params.activeSkills));

  const activeCatalogs = formatActiveMcpCatalogsForPrompt(
    params.activeMcpCatalogs,
  );
  if (activeCatalogs) {
    blocks.push(renderTagBlock("active-mcp-catalogs", activeCatalogs));
  }

  const toolGuidance = formatToolGuidanceForPrompt(params.toolGuidance ?? []);
  if (toolGuidance) {
    blocks.push(renderTagBlock("tool-guidance", toolGuidance));
  }

  const providerCatalog = formatProviderCatalogForPrompt();
  if (providerCatalog) {
    blocks.push(renderTagBlock("providers", providerCatalog));
  }

  return renderTagBlock("capabilities", blocks.join("\n\n"));
}

type TurnContextPromptInput = {
  availableSkills: SkillMetadata[];
  activeSkills: Skill[];
  activeMcpCatalogs?: ActiveMcpCatalogSummary[];
  toolGuidance?: ToolPromptContext[];
  runtime?: {
    channelId?: string;
    fastModelId?: string;
    modelId?: string;
    slackCapabilities?: {
      canAddReactions?: boolean;
      canCreateCanvas?: boolean;
      canPostToChannel?: boolean;
    };
    thinkingLevel?: string;
  };
  invocation: SkillInvocation | null;
  requester?: {
    userName?: string;
    fullName?: string;
    userId?: string;
  };
  artifactState?: ThreadArtifactsState;
  configuration?: Record<string, unknown>;
  /**
   * Whether this turn is a fresh prompt or a resume from a prior checkpoint
   * (OAuth pause or timeout-resume). Surfaced in <context> so the model knows
   * it is continuing rather than starting fresh.
   */
  turnState?: "fresh" | "resumed";
};

const STATIC_SYSTEM_PROMPT = [
  HEADER,
  buildIdentitySection(),
  renderTagBlock("personality", JUNIOR_PERSONALITY.trim()),
  renderTagBlock("behavior", buildBehaviorSection()),
  buildOutputSection(),
].join("\n\n");

/** Return byte-stable platform instructions shared by every conversation and turn. */
export function buildSystemPrompt(): string {
  return STATIC_SYSTEM_PROMPT;
}

/** Build volatile runtime context that belongs in the user turn, not the system prompt. */
export function buildTurnContextPrompt(params: TurnContextPromptInput): string {
  // Pi-agent discloses only stable runtime tools natively. MCP tool catalogs
  // are dynamic data, so expose them through loadSkill/searchMcpTools/
  // <active-mcp-catalogs> and execute them through callMcpTool without mutating
  // the native tool list.
  const sections = [
    `<${TURN_CONTEXT_TAG}>`,
    TURN_CONTEXT_HEADER,
    params.turnState === "resumed"
      ? "Continue the pending turn from prior conversation history; this block is not a new user request."
      : "The current user instruction appears after this block in the same message.",
    buildCapabilitiesSection({
      availableSkills: params.availableSkills,
      activeSkills: params.activeSkills,
      activeMcpCatalogs: params.activeMcpCatalogs ?? [],
      toolGuidance: params.toolGuidance ?? [],
    }),
    buildContextSection({
      requester: params.requester,
      artifactState: params.artifactState,
      configuration: params.configuration,
      invocation: params.invocation,
      turnState: params.turnState,
    }),
    buildRuntimeSection(params.runtime ?? {}),
    `</${TURN_CONTEXT_TAG}>`,
  ];

  return sections.join("\n\n");
}
