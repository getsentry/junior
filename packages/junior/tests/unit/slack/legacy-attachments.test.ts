import { describe, expect, it } from "vitest";
import {
  sanitizeSlackLegacyAttachments,
  renderSlackLegacyAttachmentText,
  appendSlackLegacyAttachmentText,
} from "@/chat/slack/legacy-attachments";

describe("sanitizeSlackLegacyAttachments", () => {
  it("returns empty array for non-array input", () => {
    expect(sanitizeSlackLegacyAttachments(undefined)).toEqual([]);
    expect(sanitizeSlackLegacyAttachments(null)).toEqual([]);
    expect(sanitizeSlackLegacyAttachments("string")).toEqual([]);
    expect(sanitizeSlackLegacyAttachments(42)).toEqual([]);
  });

  it("extracts text-bearing fields and drops noise", () => {
    const raw = [
      {
        fallback: "Deploy failed",
        color: "#ff0000",
        title: "Production deploy",
        title_link: "https://example.com/deploy/123",
        text: "OOM on pod-42",
        fields: [
          { title: "Status", value: "Failed", short: true },
          { title: "Owner", value: "Platform" },
        ],
        footer: "Datadog Monitor",
        callback_id: "should_be_dropped",
        actions: [{ text: "Ack", type: "button" }],
        image_url: "https://example.com/chart.png",
      },
    ];

    const result = sanitizeSlackLegacyAttachments(raw);
    expect(result).toHaveLength(1);

    const att = result[0]!;
    expect(att.fallback).toBe("Deploy failed");
    expect(att.title).toBe("Production deploy");
    expect(att.title_link).toBe("https://example.com/deploy/123");
    expect(att.text).toBe("OOM on pod-42");
    expect(att.fields).toEqual([
      { title: "Status", value: "Failed", short: true },
      { title: "Owner", value: "Platform" },
    ]);
    expect(att.footer).toBe("Datadog Monitor");

    // Should not include noise fields
    expect(att).not.toHaveProperty("color");
    expect(att).not.toHaveProperty("callback_id");
    expect(att).not.toHaveProperty("actions");
    expect(att).not.toHaveProperty("image_url");
  });

  it("skips attachments with no text content", () => {
    const raw = [{ color: "#36a64f" }, { fallback: "real content" }];
    const result = sanitizeSlackLegacyAttachments(raw);
    expect(result).toHaveLength(1);
    expect(result[0]!.fallback).toBe("real content");
  });

  it("caps at 10 attachments", () => {
    const raw = Array.from({ length: 15 }, (_, i) => ({
      fallback: `item-${i}`,
    }));
    const result = sanitizeSlackLegacyAttachments(raw);
    expect(result).toHaveLength(10);
  });
});

describe("renderSlackLegacyAttachmentText", () => {
  it("renders attachment with rich fields, deduplicating fallback", () => {
    const raw = [
      {
        fallback: "Deploy failed on prod",
        title: "Production deploy",
        title_link: "https://example.com/deploy",
        text: "OOM on pod-42",
        fields: [{ title: "Status", value: "Failed" }],
        footer: "Datadog",
      },
    ];
    const text = renderSlackLegacyAttachmentText(raw);
    // fallback should be deduplicated when rich content exists
    expect(text).toContain("[attachment]");
    expect(text).toContain("Production deploy (https://example.com/deploy)");
    expect(text).toContain("OOM on pod-42");
    expect(text).toContain("Status: Failed");
    expect(text).toContain("Datadog");
  });

  it("uses fallback when no rich content exists", () => {
    const raw = [{ fallback: "Alert: CPU usage high" }];
    const text = renderSlackLegacyAttachmentText(raw);
    expect(text).toBe("[attachment] Alert: CPU usage high");
  });

  it("returns empty string for no attachments", () => {
    expect(renderSlackLegacyAttachmentText(undefined)).toBe("");
    expect(renderSlackLegacyAttachmentText([])).toBe("");
  });
});

describe("appendSlackLegacyAttachmentText", () => {
  it("returns base text when no attachments", () => {
    expect(appendSlackLegacyAttachmentText("hello", undefined)).toBe("hello");
    expect(appendSlackLegacyAttachmentText("hello", [])).toBe("hello");
  });

  it("returns attachment text when base is empty", () => {
    const raw = [{ fallback: "Alert fired" }];
    const result = appendSlackLegacyAttachmentText("", raw);
    expect(result).toBe("[attachment] Alert fired");
  });

  it("combines base text and attachment text", () => {
    const raw = [{ fallback: "Alert fired" }];
    const result = appendSlackLegacyAttachmentText("Check this out", raw);
    expect(result).toBe("Check this out\n[attachment] Alert fired");
  });

  it("returns empty string when both are empty", () => {
    expect(appendSlackLegacyAttachmentText("", [])).toBe("");
    expect(appendSlackLegacyAttachmentText(undefined, undefined)).toBe("");
  });
});
