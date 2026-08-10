const MAX_BLOCKS = 50;
const MAX_CHILDREN = 50;
const MAX_DEPTH = 16;
const MAX_NODES = 5_000;

// Bound recursive work before attachment-level output truncation handles size.
const CHILD_KEYS = [
  "blocks",
  "elements",
  "fields",
  "accessory",
  "element",
  "rows",
  "cells",
] as const;

type TraversalBudget = {
  remainingNodes: number;
};

function toText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readText(value: unknown): string | undefined {
  if (typeof value === "string") return toText(value);
  if (!value || typeof value !== "object") return undefined;
  return toText((value as Record<string, unknown>).text);
}

function parseChildren(
  value: unknown,
  budget: TraversalBudget,
  depth: number,
): string[] {
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_CHILDREN)
      .flatMap((child) => parseChildren(child, budget, depth));
  }
  return parseElement(value, budget, depth);
}

function parseElement(
  value: unknown,
  budget: TraversalBudget,
  depth: number,
): string[] {
  if (
    !value ||
    typeof value !== "object" ||
    depth > MAX_DEPTH ||
    budget.remainingNodes <= 0
  ) {
    return [];
  }
  budget.remainingNodes -= 1;

  const element = value as Record<string, unknown>;
  const type = toText(element.type);
  const text = readText(element.text);

  if (type === "link") {
    const url = toText(element.url);
    return [
      text && url && text !== url ? `${text} (${url})` : text || url,
    ].filter((part): part is string => Boolean(part));
  }

  if (type === "button") {
    const url = toText(element.url);
    return [text && url ? `${text} (${url})` : text].filter(
      (part): part is string => Boolean(part),
    );
  }

  if (type === "emoji") {
    const name = toText(element.name);
    return name ? [`:${name}:`] : [];
  }

  if (type === "user") {
    const userId = toText(element.user_id);
    return userId ? [`<@${userId}>`] : [];
  }

  if (type === "channel") {
    const channelId = toText(element.channel_id);
    return channelId ? [`<#${channelId}>`] : [];
  }

  if (type === "usergroup") {
    const usergroupId = toText(element.usergroup_id);
    return usergroupId ? [`<!subteam^${usergroupId}>`] : [];
  }

  if (type === "broadcast") {
    const range = toText(element.range);
    return range ? [`<!${range}>`] : [];
  }

  const parts = [
    text,
    readText(element.title),
    readText(element.description),
    readText(element.label),
    readText(element.hint),
    readText(element.placeholder),
    toText(element.alt_text),
    toText(element.provider_name),
    toText(element.fallback),
  ].filter((part): part is string => Boolean(part));

  for (const key of CHILD_KEYS) {
    parts.push(...parseChildren(element[key], budget, depth + 1));
  }
  // Checkbox and radio labels are always visible. Select and overflow options
  // stay hidden until interaction, and their values may contain private data.
  if (type === "checkboxes" || type === "radio_buttons") {
    parts.push(...parseChildren(element.options, budget, depth + 1));
  }

  return parts;
}

/** Render visible block text without exposing hidden interaction data. */
export function renderBlockText(value: unknown): string {
  if (!Array.isArray(value)) return "";

  const budget: TraversalBudget = { remainingNodes: MAX_NODES };
  return value
    .slice(0, MAX_BLOCKS)
    .flatMap((block) => parseElement(block, budget, 0))
    .join("\n");
}
