import type { PluginCliDefinition } from "./cli";
import type { PluginCodeLinks } from "./code";
import {
  isPluginModelCostEventName,
  type PluginConversationEventDefinition,
} from "./conversation-events";
import type { PluginHooks } from "./hooks";
import type { PluginImageSource } from "./images";
import type { PluginInboxSubjectKind } from "./inbox-items";
import type { PluginManifest } from "./manifest";
import {
  objectLinkFilterSchema,
  type PluginObjectLinkDefinition,
} from "./object-links";
import { objectTypeSchema } from "./object-presentation";
import type { PluginTasks } from "./tasks";
import type { PluginUserPageDefinition } from "./user-pages";
import { pluginEventsSchema, type PluginEvents } from "./events";

export interface PluginModelConfig {
  /** Host model family used when no explicit structured model id is configured. */
  structuredModel?: "default" | "fast";
  /** Host model id used for this plugin's structured model calls. */
  structuredModelId?: string;
}

export type PluginRegistrationInput = {
  cli?: PluginCliDefinition;
  /** Web pages of the code changes that this plugin records. */
  codeLinks?: PluginCodeLinks;
  conversationEvents?: PluginConversationEventDefinition[];
  hooks?: PluginHooks;
  /** Images that this plugin serves through the Junior image proxy. */
  images?: PluginImageSource;
  /** The kinds of Inbox items that this plugin adds. */
  inboxSubjects?: PluginInboxSubjectKind[];
  manifest: PluginManifest;
  model?: PluginModelConfig;
  /** URLs that this plugin shows as object cards. */
  objectLinks?: PluginObjectLinkDefinition[];
  packageName?: string | undefined;
  events?: PluginEvents;
  tasks?: PluginTasks;
  userPages?: PluginUserPageDefinition[];
};

export interface PluginRegistration extends PluginRegistrationInput {}

const PLUGIN_NAME_RE = /^[a-z][a-z0-9-]*$/;
const INBOX_SUBJECT_KIND_RE = /^[a-z][a-z0-9_]*$/;
const SQL_IDENTIFIER_RE = /^[a-z][a-z0-9_]{0,62}$/;
// Core Inbox subject kinds. A plugin kind starts with the plugin name, so a
// plugin with one of these names could take over core items.
const CORE_INBOX_SUBJECT_NAMESPACES = new Set([
  "agent",
  "automation",
  "reply",
  "todo",
]);
const USER_PAGE_ID_RE = /^[a-z][a-z0-9-]*$/;

/** Define one Junior plugin registration for app and build-time wiring. */
export function defineJuniorPlugin(
  plugin: PluginRegistrationInput,
): PluginRegistration {
  if ("pluginConfig" in plugin) {
    throw new Error(
      "pluginConfig is no longer supported. Put runtime metadata in manifest or plugin registration fields.",
    );
  }
  if ("name" in plugin) {
    throw new Error("defineJuniorPlugin() uses manifest.name for identity.");
  }
  const manifest = plugin.manifest;
  if (!manifest) {
    throw new Error(
      "defineJuniorPlugin() requires a manifest. Use a package name string in defineJuniorPlugins([...]) for plugin.yaml packages.",
    );
  }
  const name = manifest.name;
  if (!name) {
    throw new Error("Plugin manifest.name is required.");
  }
  if (!PLUGIN_NAME_RE.test(name)) {
    throw new Error(
      `Plugin registration name "${name}" must be a lowercase plugin identifier.`,
    );
  }
  if (name === "junior") {
    throw new Error(
      'Plugin registration name "junior" is reserved for native host events.',
    );
  }
  if (CORE_INBOX_SUBJECT_NAMESPACES.has(name)) {
    throw new Error(
      `Plugin registration name "${name}" is reserved for core Inbox items.`,
    );
  }
  if (
    typeof manifest.displayName !== "string" ||
    !manifest.displayName.trim()
  ) {
    throw new Error(`Plugin "${name}" manifest.displayName is required.`);
  }
  if (
    typeof manifest.description !== "string" ||
    !manifest.description.trim()
  ) {
    throw new Error(`Plugin "${name}" manifest.description is required.`);
  }
  if (plugin.userPages !== undefined && !Array.isArray(plugin.userPages)) {
    throw new Error(`Plugin "${name}" userPages must be an array.`);
  }
  if (
    plugin.conversationEvents !== undefined &&
    !Array.isArray(plugin.conversationEvents)
  ) {
    throw new Error(`Plugin "${name}" conversationEvents must be an array.`);
  }
  if (plugin.events !== undefined) {
    const parsed = pluginEventsSchema.safeParse(plugin.events);
    if (!parsed.success) {
      throw new Error(`Plugin "${name}" events is invalid.`, {
        cause: parsed.error,
      });
    }
  }
  validateObjectLinks(name, plugin.objectLinks);
  validateInboxSubjects(name, plugin.inboxSubjects);
  if (
    plugin.images !== undefined &&
    typeof plugin.images.resolve !== "function"
  ) {
    throw new Error(`Plugin "${name}" images must have a resolve function.`);
  }
  const conversationEventIds = new Set<string>();
  for (const event of plugin.conversationEvents ?? []) {
    if (
      !event ||
      (typeof event !== "object" && typeof event !== "function") ||
      typeof event.parse !== "function" ||
      typeof event.renderEvent !== "function"
    ) {
      throw new Error(
        `Plugin "${name}" conversation event definitions must be created with defineConversationEvent().`,
      );
    }
    if (isPluginModelCostEventName(event.eventName)) {
      throw new Error(
        `Plugin "${name}" cannot register host-owned conversation event "${event.eventName}".`,
      );
    }
    const id = `${event.eventName}@${event.version}`;
    if (conversationEventIds.has(id)) {
      throw new Error(
        `Plugin "${name}" has duplicate conversation event "${id}".`,
      );
    }
    conversationEventIds.add(id);
  }
  const userPageIds = new Set<string>();
  for (const page of plugin.userPages ?? []) {
    if (!page || typeof page !== "object") {
      throw new Error(`Plugin "${name}" user pages must be objects.`);
    }
    if (
      typeof page.id !== "string" ||
      page.id.length > 64 ||
      !USER_PAGE_ID_RE.test(page.id)
    ) {
      throw new Error(
        `Plugin "${name}" user page id "${page.id}" must be a lowercase identifier.`,
      );
    }
    if (userPageIds.has(page.id)) {
      throw new Error(
        `Plugin "${name}" has duplicate user page id "${page.id}".`,
      );
    }
    if (
      typeof page.label !== "string" ||
      !page.label.trim() ||
      page.label.length > 80 ||
      typeof page.description !== "string" ||
      !page.description.trim() ||
      page.description.length > 500
    ) {
      throw new Error(
        `Plugin "${name}" user page "${page.id}" requires label and description.`,
      );
    }
    if (
      page.navigation !== undefined &&
      page.navigation !== "primary" &&
      page.navigation !== "profile" &&
      page.navigation !== "admin"
    ) {
      throw new Error(
        `Plugin "${name}" user page "${page.id}" navigation must be "primary", "profile", or "admin".`,
      );
    }
    if (typeof page.read !== "function") {
      throw new Error(
        `Plugin "${name}" user page "${page.id}" requires a read function.`,
      );
    }
    userPageIds.add(page.id);
  }
  return {
    ...plugin,
  };
}

function validateObjectLinks(
  name: string,
  links: PluginObjectLinkDefinition[] | undefined,
): void {
  if (links === undefined) return;
  if (!Array.isArray(links)) {
    throw new Error(`Plugin "${name}" objectLinks must be an array.`);
  }
  for (const link of links) {
    if (
      !Array.isArray(link?.objectTypes) ||
      link.objectTypes.length === 0 ||
      !link.objectTypes.every(
        (type) => objectTypeSchema.safeParse(type).success,
      ) ||
      typeof link.canView !== "function" ||
      typeof link.resolve !== "function" ||
      !Array.isArray(link.filters) ||
      link.filters.length === 0
    ) {
      throw new Error(
        `Plugin "${name}" object links need objectTypes, filters, a canView function, and a resolve function.`,
      );
    }
    for (const filter of link.filters) {
      const parsed = objectLinkFilterSchema.safeParse(filter);
      if (!parsed.success) {
        throw new Error(
          `Plugin "${name}" has an invalid ${link.objectTypes.join("/")} link filter.`,
          { cause: parsed.error },
        );
      }
    }
  }
}

function validateInboxSubjects(
  name: string,
  kinds: PluginInboxSubjectKind[] | undefined,
): void {
  if (kinds === undefined) return;
  if (!Array.isArray(kinds)) {
    throw new Error(`Plugin "${name}" inboxSubjects must be an array.`);
  }
  const seen = new Set<string>();
  for (const subject of kinds) {
    if (
      typeof subject?.kind !== "string" ||
      !INBOX_SUBJECT_KIND_RE.test(subject.kind) ||
      typeof subject.label !== "string" ||
      !subject.label.trim() ||
      (subject.ask !== undefined && typeof subject.ask !== "function")
    ) {
      throw new Error(
        `Plugin "${name}" inbox subjects need a snake_case kind and a label.`,
      );
    }
    const owner = subject.owner;
    if (
      owner !== "annotation" &&
      ![owner?.table, owner?.subjectId, owner?.conversationId].every(
        (identifier) =>
          typeof identifier === "string" && SQL_IDENTIFIER_RE.test(identifier),
      )
    ) {
      throw new Error(
        `Plugin "${name}" inbox subject "${subject.kind}" needs an owner: "annotation", or a table, subjectId column, and conversationId column in snake_case.`,
      );
    }
    if (
      subject.assigneeRoles !== undefined &&
      typeof subject.assigneeRoles !== "boolean"
    ) {
      throw new Error(
        `Plugin "${name}" inbox subject "${subject.kind}" assigneeRoles must be a boolean.`,
      );
    }
    if (seen.has(subject.kind)) {
      throw new Error(
        `Plugin "${name}" has duplicate inbox subject kind "${subject.kind}".`,
      );
    }
    seen.add(subject.kind);
  }
}
