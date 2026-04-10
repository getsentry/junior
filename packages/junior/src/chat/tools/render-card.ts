import { isConversationScopedChannel } from "@/chat/slack/client";
import { renderSlackSentryIssueCard } from "@/chat/cards/slack/sentry-issue";
import { Type } from "@sinclair/typebox";
import { tool } from "@/chat/tools/definition";
import type { ToolHooks, ToolRuntimeContext } from "@/chat/tools/types";
import {
  getPluginCardDeclarations,
  getCardDeclaration,
} from "@/chat/plugins/registry";
import type {
  CardFieldSchema,
  PluginCardDeclaration,
} from "@/chat/plugins/types";
import { renderCard } from "@/chat/cards/render";
import { resolveEntityKey, resolveCardTemplate } from "@/chat/cards/template";

/** Build a human-readable tool description from all registered card declarations. */
function buildToolDescription(): string {
  const declarations = getPluginCardDeclarations();
  if (declarations.length === 0) {
    return "Render structured data as a rich card. No card types are currently available.";
  }

  const typeLines = declarations.map(({ pluginName, card }) => {
    const fields = Object.entries(card.schema)
      .map(([name, def]) => {
        const req = def.required ? ", req" : "";
        return `${name} (${def.type}${req})`;
      })
      .join(", ");
    return `  - ${pluginName}.${card.name}: ${card.description}\n    Fields: { ${fields} }`;
  });

  return [
    "Render structured data as a rich card in the conversation.",
    "Prefer cards when you are returning one concrete entity with stable structured fields.",
    "Do not use cards for broad result lists unless a list-specific card type exists.",
    "The card itself is the user-visible response. If no extra context is needed, end the turn without additional text.",
    "After rendering a card, do not restate the same structured fields in prose. Keep any text to brief context or next steps.",
    "",
    "Available card types:",
    ...typeLines,
  ].join("\n");
}

/** Build the list of valid type values for the tool schema. */
function buildTypeEnum(): string[] {
  return getPluginCardDeclarations().map(
    ({ pluginName, card }) => `${pluginName}.${card.name}`,
  );
}

/** Validate data against a card's schema. Returns an error message or null. */
function validateCardData(
  card: PluginCardDeclaration,
  data: Record<string, unknown>,
): string | null {
  for (const [fieldName, fieldDef] of Object.entries(card.schema)) {
    const value = data[fieldName];

    if (
      fieldDef.required &&
      (value === undefined || value === null || value === "")
    ) {
      return `Missing required field '${fieldName}'`;
    }

    if (value === undefined || value === null) {
      continue;
    }

    if (fieldDef.type === "integer" && typeof value !== "number") {
      return `Field '${fieldName}' expected integer, got ${typeof value}`;
    }
    if (fieldDef.type === "string" && typeof value !== "string") {
      return `Field '${fieldName}' expected string, got ${typeof value}`;
    }
    if (fieldDef.type === "boolean" && typeof value !== "boolean") {
      return `Field '${fieldName}' expected boolean, got ${typeof value}`;
    }
    if (
      fieldDef.enum &&
      typeof value === "string" &&
      !fieldDef.enum.includes(value)
    ) {
      return `Field '${fieldName}' must be one of: ${fieldDef.enum.join(", ")}`;
    }
  }

  return null;
}

/** Create the render_card tool. Returns undefined if no plugins declare cards. */
export function createRenderCardTool(
  hooks: ToolHooks,
  context: ToolRuntimeContext,
) {
  if (!hooks.onCardRendered) {
    return undefined;
  }

  const typeEnum = buildTypeEnum();
  if (typeEnum.length === 0) {
    return undefined;
  }

  return tool({
    description: buildToolDescription(),
    inputSchema: Type.Object({
      type: Type.String({
        description:
          "Card type in the format 'plugin.card' (e.g. 'github.issue').",
      }),
      data: Type.Record(Type.String(), Type.Unknown(), {
        description: "Card data. Fields depend on the card type.",
      }),
    }),
    execute: async ({ type, data }) => {
      const result = getCardDeclaration(type);
      if (!result) {
        const available = buildTypeEnum();
        return {
          ok: false,
          error: `Unknown card type: "${type}". Available types: ${available.join(", ")}`,
        };
      }

      const { pluginName, card } = result;
      const typedData = data as Record<string, unknown>;

      const validationError = validateCardData(card, typedData);
      if (validationError) {
        return {
          ok: false,
          error: `${validationError} for card type '${type}'`,
        };
      }

      try {
        const entityKey = resolveEntityKey(card, pluginName, typedData);
        const resolved = resolveCardTemplate(card, typedData);
        const dedupeTextLines = [
          resolved.fallbackText,
          resolved.title,
          resolved.body ? `${resolved.title}: ${resolved.body}` : undefined,
          resolved.status ? `Status: ${resolved.status.text}` : undefined,
          ...(resolved.fields?.map(
            (field) => `${field.label}: ${field.value}`,
          ) ?? []),
          resolved.linkLabel,
        ].filter((value): value is string => Boolean(value && value.trim()));

        const slackMessage =
          pluginName === "sentry" &&
          card.name === "issue" &&
          context.threadTs &&
          isConversationScopedChannel(context.channelId)
            ? renderSlackSentryIssueCard({
                data: typedData,
                resolved,
              })
            : undefined;

        hooks.onCardRendered?.(
          slackMessage
            ? {
                slackMessage,
                entityKey,
                pluginName,
                fallbackText: resolved.fallbackText,
                dedupeTextLines,
              }
            : {
                cardElement: renderCard(card, pluginName, typedData),
                entityKey,
                pluginName,
                fallbackText: resolved.fallbackText,
                dedupeTextLines,
              },
        );

        return {
          ok: true,
          card_type: type,
          rendered: resolved.fallbackText,
        };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error ? error.message : "Failed to render card",
        };
      }
    },
  });
}
