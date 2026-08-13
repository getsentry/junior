export type VisualViewport = {
  height: number;
  name: string;
  width: number;
};

export type VisualScenario = {
  componentGallery?: boolean;
  id: string;
  label: string;
  path: string;
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
    id: "system",
    label: "System",
    path: "/system",
    ready: "Model spend",
    viewports: [DESKTOP],
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
    id: "component-gallery",
    label: "Component gallery",
    path: "/dev",
    ready: "Component gallery",
    viewports: [DESKTOP],
  },
];

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
      filePath.startsWith(
        "packages/junior-dashboard/src/client/conversations/",
      ) || filePath.includes("/mock-reporting/"),
    scenarioIds: ["conversations", "conversation-detail"],
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
      "conversation-detail",
      "system",
      "component-gallery",
    ],
  },
  {
    match: (filePath) =>
      filePath.startsWith("packages/junior-dashboard/src/client/pages/dev/") ||
      filePath.startsWith("packages/junior-dashboard/src/client/components/"),
    scenarioIds: ["component-gallery"],
  },
  {
    match: (filePath) =>
      filePath.startsWith("packages/junior-dashboard/") &&
      !filePath.startsWith("packages/junior-dashboard/e2e/") &&
      !filePath.startsWith("packages/junior-dashboard/tests/") &&
      !filePath.startsWith("packages/junior-dashboard/visual/"),
    scenarioIds: ["component-gallery"],
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

  return VISUAL_SCENARIOS.map((scenario) => scenario.id)
    .filter((id) => selected.has(id))
    .slice(0, max);
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
