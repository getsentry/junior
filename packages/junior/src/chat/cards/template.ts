import type {
  CardRenderTemplate,
  PluginCardDeclaration,
} from "@/chat/plugins/types";

interface ResolvedCardRender {
  title: string;
  titleUrl?: string;
  body?: string;
  linkLabel?: string;
  status?: {
    text: string;
    style: "success" | "warning" | "danger" | "default";
  };
  fields?: Array<{ label: string; value: string }>;
  fallbackText: string;
}

/** Resolve a `{{field}}` template string against a data object. */
function interpolate(template: string, data: Record<string, unknown>): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path: string) => {
    const trimmed = path.trim();
    const segments = trimmed.split(".");
    let current: unknown = data;

    for (const segment of segments) {
      if (current == null || typeof current !== "object") {
        return "";
      }
      current = (current as Record<string, unknown>)[segment];
    }

    return current == null ? "" : String(current);
  });
}

/** Resolve a card render template against data, producing display-ready values. */
export function resolveCardTemplate(
  card: PluginCardDeclaration,
  data: Record<string, unknown>,
): ResolvedCardRender {
  const render = card.render;
  const title = interpolate(render.title, data);
  if (!title) {
    throw new Error("Card title resolved to empty string");
  }

  const result: ResolvedCardRender = {
    title,
    fallbackText: interpolate(render.fallbackText, data),
  };

  if (render.titleUrl) {
    const url = interpolate(render.titleUrl, data);
    if (url) {
      result.titleUrl = url;
    }
  }

  if (render.body) {
    const body = interpolate(render.body, data);
    if (body) {
      result.body = body;
    }
  }

  if (render.linkLabel) {
    const linkLabel = interpolate(render.linkLabel, data);
    if (linkLabel) {
      result.linkLabel = linkLabel;
    }
  }

  if (render.status) {
    const statusText = interpolate(render.status.text, data);
    if (statusText) {
      const style =
        render.status.styleMap?.[statusText] ?? ("default" as const);
      result.status = { text: statusText, style };
    }
  }

  if (render.fields) {
    const fields: Array<{ label: string; value: string }> = [];
    for (const fieldDef of render.fields) {
      const value = interpolate(fieldDef.value, data);
      if (value || fieldDef.fallback) {
        fields.push({
          label: fieldDef.label,
          value: value || fieldDef.fallback!,
        });
      }
    }
    if (fields.length > 0) {
      result.fields = fields;
    }
  }

  return result;
}

/** Resolve the entity key template for update-in-place tracking. */
export function resolveEntityKey(
  card: PluginCardDeclaration,
  pluginName: string,
  data: Record<string, unknown>,
): string {
  const resolved = interpolate(card.entityKey, data);
  return `${pluginName}.${resolved}`;
}
