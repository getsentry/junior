export type VisualViewport = {
  height: number;
  name: string;
  width: number;
};

export type VisualScenarioPrepare =
  | "attachment-entry"
  | "attachment-modal"
  | "conversation-detail-focused"
  | "new-conversation-focused";

export type VisualScenario = {
  componentGallery?: boolean;
  id: string;
  label: string;
  path: string;
  /**
   * Optional interaction before the shot. Capture owns the Playwright steps so
   * this registry stays data-only.
   */
  prepare?: VisualScenarioPrepare;
  /** Accessible heading used as the ready-state signal. */
  ready: string;
  viewports: VisualViewport[];
};

export const DESKTOP: VisualViewport = {
  height: 900,
  name: "desktop",
  width: 1440,
};

export const MOBILE: VisualViewport = {
  height: 844,
  name: "mobile",
  width: 390,
};

const ACTIVE_CONVERSATION_ID = "slack:CQA123:1770003600.000200";
const DASHBOARD_QA_CONVERSATION_ID = "internal:dashboard-qa";
const WORKSPACE_ID = "11111111-1111-4111-8111-111111111111";

/** Named dashboard surfaces CI can screenshot for a PR. */
export const VISUAL_SCENARIOS: VisualScenario[] = [
  {
    id: "conversations",
    label: "Conversations",
    path: "/",
    ready: "Conversations",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "conversation-detail",
    label: "Conversation detail",
    path: `/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
    ready: "Investigate checkout latency",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "conversation-attachment",
    label: "Conversation attachment",
    path: `/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`,
    prepare: "attachment-entry",
    ready: "Dashboard QA edge cases",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "conversation-attachment-modal",
    label: "Conversation attachment modal",
    path: `/conversations/${encodeURIComponent(DASHBOARD_QA_CONVERSATION_ID)}`,
    prepare: "attachment-modal",
    ready: "Dashboard QA edge cases",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "conversation-detail-focused",
    label: "Conversation detail · focused composer",
    path: `/conversations/${encodeURIComponent(ACTIVE_CONVERSATION_ID)}`,
    // Focus the reply composer and shrink the visual viewport so the PR
    // screenshot shows the input docked above the keyboard with chat chrome.
    prepare: "conversation-detail-focused",
    ready: "Investigate checkout latency",
    viewports: [MOBILE],
  },
  {
    id: "conversation-create-focused",
    label: "New conversation · centered compose",
    path: "/",
    // Open create mode and focus the composer. Capture the centered empty-state
    // stack (title + privacy + input), not a keyboard-docked reply footer.
    prepare: "new-conversation-focused",
    ready: "Conversations",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "person-profile",
    label: "Person profile",
    path: `/people/${encodeURIComponent("avery@sentry.io")}`,
    // Wait for the plugin section so async profile reports are present.
    ready: "GitHub",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "system",
    label: "System",
    path: "/system",
    // Page header, not a buried chart/stat label.
    ready: "System",
    viewports: [DESKTOP],
  },
  {
    id: "workspaces",
    label: "Workspaces",
    path: "/system/workspaces",
    // Baseline card heading proves the list payload rendered.
    ready: "Baseline snapshot",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "workspace-detail",
    label: "Workspace detail",
    path: `/system/workspaces/${WORKSPACE_ID}`,
    ready: "Current snapshot",
    viewports: [DESKTOP, MOBILE],
  },
  {
    id: "memories",
    label: "Memories",
    path: "/memories",
    ready: "Memories",
    viewports: [DESKTOP],
  },
  {
    id: "settings",
    label: "Settings",
    path: "/settings",
    ready: "Settings",
    viewports: [DESKTOP],
  },
  {
    componentGallery: true,
    id: "gallery-index",
    label: "Component gallery index",
    path: "/dev",
    ready: "Component gallery",
    viewports: [DESKTOP],
  },
  {
    componentGallery: true,
    id: "gallery-foundations",
    label: "Gallery · Foundations",
    path: "/dev/foundations",
    ready: "Foundations",
    viewports: [DESKTOP],
  },
  {
    componentGallery: true,
    id: "gallery-charts",
    label: "Gallery · Charts",
    path: "/dev/charts",
    ready: "Charts",
    viewports: [DESKTOP],
  },
  {
    componentGallery: true,
    id: "gallery-transcripts",
    label: "Gallery · Transcripts",
    path: "/dev/transcripts",
    ready: "Transcripts",
    viewports: [DESKTOP],
  },
];

/** Prefer these gallery scenarios under the selection cap when kit files change. */
const GALLERY_SCENARIO_PRIORITY = [
  "gallery-foundations",
  "gallery-charts",
  "gallery-transcripts",
  "gallery-index",
] as const;

const SCENARIO_BY_ID = new Map(
  VISUAL_SCENARIOS.map((scenario) => [scenario.id, scenario]),
);

type PathRule = {
  match: (filePath: string) => boolean;
  scenarioIds: string[];
};

const PATH_RULES: PathRule[] = [
  {
    match: (filePath) =>
      filePath ===
        "packages/junior-dashboard/src/client/components/ImageAttachment.tsx" ||
      filePath ===
        "packages/junior-dashboard/src/client/conversations/TranscriptAttachmentsDeliveredView.tsx",
    scenarioIds: [
      "conversation-attachment",
      "conversation-attachment-modal",
    ],
  },
  {
    match: (filePath) =>
      /\/conversations\/Transcript(?:Markdown|Text|ToolView)\.tsx$/.test(
        filePath,
      ),
    scenarioIds: ["gallery-transcripts"],
  },
  {
    // Keep chart-gallery paths ahead of people/system feature rules.
    match: (filePath) =>
      filePath.startsWith(
        "packages/junior-dashboard/src/client/components/charts/",
      ) ||
      filePath.startsWith(
        "packages/junior-dashboard/src/client/pages/people/ContributionGrid",
      ) ||
      filePath.startsWith(
        "packages/junior-dashboard/src/client/pages/locations/LocationDirectoryActivityChart",
      ) ||
      filePath.startsWith(
        "packages/junior-dashboard/src/client/pages/system/ConversationActivityChart",
      ),
    scenarioIds: ["gallery-charts"],
  },
  {
    match: (filePath) =>
      filePath ===
        "packages/junior-dashboard/src/client/mobileViewport.ts" ||
      filePath ===
        "packages/junior-dashboard/src/client/bodyScrollLock.ts" ||
      filePath ===
        "packages/junior-dashboard/src/client/components/layout/VisualViewportShell.tsx" ||
      filePath.startsWith(
        "packages/junior-dashboard/src/client/conversations/",
      ) ||
      filePath.includes("/mock-reporting/"),
    scenarioIds: [
      "conversations",
      "conversation-detail",
      "conversation-detail-focused",
      "conversation-create-focused",
    ],
  },
  {
    match: (filePath) =>
      filePath.startsWith("packages/junior-dashboard/src/client/pages/people/"),
    scenarioIds: ["person-profile"],
  },
  {
    match: (filePath) =>
      filePath.startsWith(
        "packages/junior-dashboard/src/client/pages/system/",
      ) &&
      /(?:^|\/)(?:BaselineSnapshot|SnapshotSummary|Workspace|workspace)/.test(
        filePath,
      ),
    scenarioIds: ["workspaces", "workspace-detail"],
  },
  {
    match: (filePath) =>
      filePath.startsWith("packages/junior-dashboard/src/client/pages/system/"),
    scenarioIds: ["system"],
  },
  {
    match: (filePath) =>
      filePath.startsWith("packages/junior-dashboard/src/client/pages/memory/"),
    scenarioIds: ["memories"],
  },
  {
    match: (filePath) =>
      filePath === "packages/junior-dashboard/src/client/pages/SettingsPage.tsx" ||
      filePath ===
        "packages/junior-dashboard/src/client/pages/PersonalTokensPage.tsx",
    scenarioIds: ["settings"],
  },
  {
    match: (filePath) =>
      filePath === "packages/junior-dashboard/src/client/App.tsx" ||
      filePath === "packages/junior-dashboard/src/tailwind.css" ||
      filePath.startsWith("packages/junior-dashboard/src/client/styles") ||
      filePath.startsWith(
        "packages/junior-dashboard/src/client/components/layout/",
      ),
    scenarioIds: [
      "conversations",
      "conversation-detail-focused",
      "conversation-create-focused",
      "system",
    ],
  },
  {
    match: (filePath) =>
      filePath.startsWith("packages/junior-dashboard/src/client/pages/dev/"),
    scenarioIds: [
      "gallery-foundations",
      "gallery-charts",
      "gallery-transcripts",
      "gallery-index",
    ],
  },
  {
    match: (filePath) =>
      filePath.startsWith("packages/junior-dashboard/src/client/components/"),
    scenarioIds: ["gallery-foundations", "gallery-index"],
  },
  {
    match: (filePath) =>
      filePath.startsWith("packages/junior-dashboard/") &&
      !filePath.startsWith("packages/junior-dashboard/e2e/") &&
      !filePath.startsWith("packages/junior-dashboard/tests/") &&
      !filePath.startsWith("packages/junior-dashboard/visual/"),
    scenarioIds: ["gallery-index"],
  },
];

/** Hard cap so broad CSS/layout diffs stay reviewable. */
export const MAX_VISUAL_SCENARIOS = 4;

/** PR label that forces every registered scenario. */
export const VISUAL_ALL_LABEL = "trigger-visual";

/** Return every registered scenario id in registry order. */
export function allVisualScenarioIds(): string[] {
  return VISUAL_SCENARIOS.map((scenario) => scenario.id);
}

/** Pick scenario ids for the changed paths. Empty means skip visual CI. */
export function selectVisualScenarioIds(
  changedPaths: readonly string[],
  options: { all?: boolean; max?: number } = {},
): string[] {
  if (options.all) {
    return allVisualScenarioIds();
  }

  const max = options.max ?? MAX_VISUAL_SCENARIOS;
  const selected = new Set<string>();

  for (const filePath of changedPaths) {
    const normalized = filePath.replaceAll("\\", "/");
    for (const rule of PATH_RULES) {
      if (!rule.match(normalized)) continue;
      for (const scenarioId of rule.scenarioIds) {
        selected.add(scenarioId);
      }
      break;
    }
  }

  // Prefer focused gallery pages first so shared kit diffs stay reviewable.
  const galleryIds = GALLERY_SCENARIO_PRIORITY.filter((id) => selected.has(id));
  const galleryIdSet = new Set<string>(galleryIds);
  const rest = VISUAL_SCENARIOS.map((scenario) => scenario.id).filter(
    (id) => selected.has(id) && !galleryIdSet.has(id),
  );
  return [...galleryIds, ...rest].slice(0, max);
}

/** Resolve scenario records for selected ids, preserving registry order. */
export function resolveVisualScenarios(
  scenarioIds: readonly string[],
): VisualScenario[] {
  const scenarios: VisualScenario[] = [];
  for (const id of scenarioIds) {
    const scenario = SCENARIO_BY_ID.get(id);
    if (!scenario) {
      throw new Error(`Unknown visual scenario: ${id}`);
    }
    scenarios.push(scenario);
  }
  return scenarios;
}
