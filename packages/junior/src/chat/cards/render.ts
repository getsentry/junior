import {
  Card,
  CardText,
  CardLink,
  Section,
  Fields,
  Field,
  type CardElement,
} from "chat";
import type { PluginCardDeclaration } from "@/chat/plugins/types";
import { resolveCardTemplate } from "./template";

const STATUS_STYLE_MAP: Record<string, "plain" | "bold" | "muted"> = {
  success: "bold",
  warning: "bold",
  danger: "bold",
  default: "muted",
};

/** Render a card declaration + data into a Chat SDK CardElement. */
export function renderCard(
  card: PluginCardDeclaration,
  pluginName: string,
  data: Record<string, unknown>,
): CardElement {
  const resolved = resolveCardTemplate(card, data);

  const children = [];

  if (resolved.body) {
    children.push(Section([CardText(resolved.body)]));
  }

  if (resolved.status) {
    children.push(
      Section([
        CardText(resolved.status.text, {
          style: STATUS_STYLE_MAP[resolved.status.style] ?? "muted",
        }),
      ]),
    );
  }

  if (resolved.fields) {
    children.push(
      Fields(
        resolved.fields.map((f) => Field({ label: f.label, value: f.value })),
      ),
    );
  }

  if (resolved.titleUrl) {
    children.push(
      CardLink({
        url: resolved.titleUrl,
        label: resolved.linkLabel ?? "Open",
      }),
    );
  }

  return Card({
    title: resolved.title,
    children: children.length > 0 ? children : undefined,
  });
}
