import {
  definePromptContext,
  type PluginRegistration,
} from "@sentry/junior-plugin-api";
import { z } from "zod";
import type { JuniorDatabase } from "@/db/db";
import { spaceAssignedEvent } from "./events";
import { readConversationSpace, readSpaceTree } from "./store";
import { formatSpacePath } from "./tree";

type SpacesConfig = Readonly<{ enabled?: boolean }>;

let configuredSpaces: SpacesConfig = {};

/** Replace app-level Space settings and return the previous setting. */
export function setSpacesConfig(config?: { enabled?: boolean }): SpacesConfig {
  const previous = { ...configuredSpaces };
  configuredSpaces = config ? { ...config } : {};
  return previous;
}

/** Return whether automatic Space assignment is enabled. */
export function isSpacesEnabled(): boolean {
  return configuredSpaces.enabled === true;
}

const spaceContext = definePromptContext({
  kind: "space",
  version: 1,
  schema: z
    .object({
      spaceId: z.string().min(1),
      path: z.array(z.string().min(1)).min(1),
      description: z.string(),
      parentDescriptions: z.array(z.string()),
    })
    .strict(),
  renderPrompt(content) {
    const lines = [
      `This Conversation is in the Space ${formatSpacePath(content.path)} (${content.spaceId}).`,
    ];
    if (content.description) {
      lines.push(`Space: ${content.description}`);
    }
    content.parentDescriptions.forEach((description, index) => {
      if (description) {
        lines.push(`${content.path[index]}: ${description}`);
      }
    });
    lines.push(
      "Spaces are nested forum categories of Conversations. Use the spaces tools to browse related Conversations or to reorganize Spaces when asked.",
    );
    return lines.join("\n");
  },
});

/** Core registration for Space events and the per-turn Space context. */
export const spacesRegistration: PluginRegistration = {
  manifest: {
    name: "spaces",
    displayName: "Spaces",
    description: "Nested forum categories of Conversations",
  },
  conversationEvents: [spaceAssignedEvent],
  hooks: {
    async userPrompt(context) {
      if (!context.conversationId) return undefined;
      const db = context.db as JuniorDatabase;
      const assignment = await readConversationSpace(
        db,
        context.conversationId,
      );
      if (!assignment) return undefined;
      const tree = await readSpaceTree(db);
      const space = tree.get(assignment.spaceId);
      if (!space) return undefined;
      const parentDescriptions: string[] = [];
      let parentId = space.parentSpaceId;
      while (parentId) {
        const parent = tree.get(parentId);
        if (!parent) break;
        parentDescriptions.unshift(parent.description);
        parentId = parent.parentSpaceId;
      }
      return [
        spaceContext({
          spaceId: space.spaceId,
          path: space.path,
          description: space.description,
          parentDescriptions,
        }),
      ];
    },
  },
};
