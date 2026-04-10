import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePluginManifest } from "@/chat/plugins/manifest";

describe("plugin manifest", () => {
  it("parses the sentry issue card declaration", () => {
    const pluginDir = fileURLToPath(
      new URL("../../../../junior-sentry/", import.meta.url),
    );
    const raw = fs.readFileSync(
      new URL("../../../../junior-sentry/plugin.yaml", import.meta.url),
      "utf8",
    );

    const manifest = parsePluginManifest(raw, pluginDir);
    const issueCard = manifest.cards?.find((card) => card.name === "issue");

    expect(issueCard).toMatchObject({
      name: "issue",
      entityKey: "issue:{{shortId}}",
      schema: {
        shortId: {
          type: "string",
          required: true,
        },
        title: {
          type: "string",
          required: true,
        },
        permalink: {
          type: "string",
          required: true,
        },
        status: {
          type: "string",
          required: true,
        },
        count: {
          type: "string",
        },
        userCount: {
          type: "integer",
        },
      },
      render: {
        title: "{{shortId}}",
        titleUrl: "{{permalink}}",
        body: "{{title}}",
        linkLabel: "View in Sentry",
        fallbackText: "{{shortId}}: {{title}} ({{status}})",
      },
    });
  });
});
