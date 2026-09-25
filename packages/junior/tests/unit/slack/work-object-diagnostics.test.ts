import { describe, expect, it } from "vitest";
import { slackWorkObjectDiagnostics } from "@/chat/slack/work-object-diagnostics";

describe("Work Object diagnostic redaction", () => {
  it("retains known codes and schema keys, not submitted values", () => {
    const attributes = slackWorkObjectDiagnostics({
      response_metadata: {
        warnings: ["missing_charset", "unknown_private_warning"],
        messages: [
          "[ERROR] invalid_metadata_schema: private value [json-pointer:/metadata/entities/0/entity_payload/custom_fields/private_key/value]",
          "[WARN] private title https://private.example/item/secret xoxb-private-token",
        ],
      },
      message: { metadata: { entities: [{ title: "private title" }] } },
    });

    expect(attributes).toEqual({
      "app.slack.warning_count": 2,
      "app.slack.response_message_count": 2,
      "app.slack.diagnostic_codes": [
        "missing_charset",
        "invalid_metadata_schema",
      ],
      "app.slack.diagnostic_paths": [
        "/metadata/entities/*/entity_payload/custom_fields/*/value",
      ],
      "app.slack.unrecognized_diagnostic_count": 2,
      "app.slack.diagnostics_truncated": false,
      "app.slack.work_object.response_entities_present": true,
      "app.slack.work_object.response_entity_count": 1,
    });
    expect(JSON.stringify(attributes)).not.toContain("private");
  });

  it("distinguishes absent metadata from an empty echoed entity list", () => {
    const absent = slackWorkObjectDiagnostics({ ok: true });
    expect(absent["app.slack.work_object.response_entities_present"]).toBe(
      false,
    );
    expect(absent).not.toHaveProperty(
      "app.slack.work_object.response_entity_count",
    );
    expect(
      slackWorkObjectDiagnostics({ message: { metadata: { entities: [] } } }),
    ).toMatchObject({
      "app.slack.work_object.response_entities_present": true,
      "app.slack.work_object.response_entity_count": 0,
    });
  });

  it("bounds diagnostic processing and counts malformed entries", () => {
    expect(
      slackWorkObjectDiagnostics({
        response_metadata: {
          warnings: Array.from({ length: 25 }, () => "missing_charset"),
          messages: [null, { text: "private" }, "x".repeat(2100)],
        },
      }),
    ).toMatchObject({
      "app.slack.warning_count": 25,
      "app.slack.response_message_count": 3,
      "app.slack.diagnostic_codes": ["missing_charset"],
      "app.slack.unrecognized_diagnostic_count": 3,
      "app.slack.diagnostics_truncated": true,
    });
  });
});
