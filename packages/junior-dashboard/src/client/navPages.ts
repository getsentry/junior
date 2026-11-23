import { getDashboardAgentName } from "./agentName";
import { peoplePath } from "./format";
import { systemPluginsPath } from "./pages/system/SystemPlugins";
import { pluginUserPagePath } from "./pages/user/pluginUserPageRoutes";
import { INBOX_VIEW_LABELS, inboxViewPath } from "./inbox/inboxModel";

/**
 * One dashboard page that navigation links to. The command palette lists
 * every page here, so nav and the palette never disagree. The
 * `nav-pages/listed-page-path` lint rule keeps page paths out of other
 * modules.
 */
export type NavPage = {
  /** Who can open it: anyone when unset. A page in an area follows its root. */
  access?: "account" | "admin";
  /** The heading id, when the page is a section of the page in `to`. */
  anchor?: string;
  /** The path of the area's root page, when the page is in an area's nav. */
  area?: string;
  label: string;
  /** The palette's label, where the area's nav is not there to tell it apart. */
  paletteLabel?: string;
  to: string;
};

const AUTOMATIONS = "/automations";
const MEMORIES = pluginUserPagePath("memory", "memories");
const SETTINGS = "/settings";
const SYSTEM = "/system";

function section(root: string, anchor: string, label: string): NavPage {
  return { anchor, area: root, label, to: `${root}#${anchor}` };
}

/** Every dashboard page that a link names, in nav order within each area. */
export const NAV_PAGES = {
  inbox: { label: INBOX_VIEW_LABELS.inbox, to: "/" },
  snoozed: {
    access: "account",
    label: INBOX_VIEW_LABELS.snoozed,
    to: inboxViewPath("snoozed"),
  },
  done: {
    access: "account",
    label: INBOX_VIEW_LABELS.done,
    to: inboxViewPath("done"),
  },
  conversations: {
    label: INBOX_VIEW_LABELS.conversations,
    to: inboxViewPath("conversations"),
  },
  decisions: {
    access: "account",
    label: INBOX_VIEW_LABELS.decisions,
    to: inboxViewPath("decisions"),
  },
  automations: { access: "account", label: "Automations", to: AUTOMATIONS },
  automationRuns: {
    area: AUTOMATIONS,
    label: "Runs",
    paletteLabel: "Automation runs",
    to: `${AUTOMATIONS}/runs`,
  },
  memoryActivity: section(MEMORIES, "activity", "Activity"),
  memoryCost: section(MEMORIES, "cost", "Cost"),
  memoryTypes: section(
    MEMORIES,
    "memory-types",
    `What ${getDashboardAgentName()} remembers`,
  ),
  memorySources: section(MEMORIES, "memory-sources", "How they got here"),
  memoryLibrary: {
    area: MEMORIES,
    label: "Memories",
    paletteLabel: "Memory library",
    to: `${MEMORIES}/library`,
  },
  code: { label: "Code", to: "/code" },
  system: { label: "System", to: SYSTEM },
  people: { area: SYSTEM, label: "People", to: `${SYSTEM}/people` },
  locations: { area: SYSTEM, label: "Locations", to: `${SYSTEM}/locations` },
  workspaces: {
    area: SYSTEM,
    label: "Workspaces",
    to: `${SYSTEM}/workspaces`,
  },
  plugins: { area: SYSTEM, label: "Plugins", to: systemPluginsPath },
  admin: { access: "admin", label: "Admin", to: "/admin" },
  settings: { access: "account", label: "Settings", to: SETTINGS },
  settingsGeneral: section(SETTINGS, "general", "General"),
  settingsInterface: section(SETTINGS, "interface", "Interface"),
  settingsApiTokens: section(SETTINGS, "api-tokens", "API Tokens"),
  settingsIdentities: section(SETTINGS, "identities", "Identities"),
  settingsMcp: section(SETTINGS, "mcp", "MCP"),
} satisfies Record<string, NavPage>;

/** The pages in an area's nav, such as System's, by its root page's path. */
export function navAreaPages(root: string): NavPage[] {
  return Object.values<NavPage>(NAV_PAGES).filter((page) => page.area === root);
}

/** The viewer's own profile, from the profile menu. */
export function myProfilePage(email: string): NavPage {
  return { access: "account", label: "My profile", to: peoplePath(email) };
}

/** A page row for the command palette. */
export type PalettePage = {
  /** The area's root, whose name and icon the row shows. */
  area?: { key: string; label: string };
  key: string;
  label: string;
  to: string;
};

/**
 * The pages that the palette lists beside the nav items: every page in
 * `NAV_PAGES` that the viewer can open, and their own profile. An area's
 * pages list while its root does, so plugin areas such as Memories list
 * only where the plugin is.
 */
export function paletteNavPages(input: {
  /** The signed-in viewer's email. */
  email?: string | undefined;
  isAdmin: boolean;
  navItems: readonly { key: string; label: string; to: string }[];
}): PalettePage[] {
  const open = (page: NavPage) =>
    page.access === undefined ||
    (page.access === "admin" ? input.isAdmin : Boolean(input.email));
  const pages = [
    ...Object.entries<NavPage>(NAV_PAGES).map(([key, page]) => ({
      key,
      ...page,
    })),
    ...(input.email
      ? [{ key: "my-profile", ...myProfilePage(input.email) }]
      : []),
  ];
  const roots = new Map(
    [
      ...input.navItems,
      ...pages.filter((page) => !page.area && open(page)),
    ].map((item) => [item.to, { key: item.key, label: item.label }]),
  );
  const shown = new Set(input.navItems.map((item) => item.to));
  return pages.flatMap((page) => {
    const area = page.area === undefined ? undefined : roots.get(page.area);
    if (shown.has(page.to) || (page.area ? !area : !open(page))) return [];
    shown.add(page.to);
    return [
      {
        area,
        key: page.key,
        label: page.paletteLabel ?? page.label,
        to: page.to,
      },
    ];
  });
}
