import { expect, it } from "vitest";
import { slackEntitySchema } from "@/chat/slack/work-object";

it.each([
  { id: "automation_123-abc", valid: true },
  { id: "WyJjb252ZXJzYXRpb24iLCJnaXRodWIiLCJyZXBvIzEiXQ", valid: true },
  { id: '["conversation","github","repo#1"]', valid: false },
  { id: "", valid: false },
  { id: "a b", valid: false },
  { id: "a\n", valid: false },
  { id: "修正", valid: false },
  { id: "a/b+==", valid: false },
])("validates external reference ID characters: $id", ({ id, valid }) => {
  const result = slackEntitySchema.safeParse({
    entity_type: "slack#/entities/item",
    external_ref: { id },
    url: "https://example.com/pull/1",
    entity_payload: { attributes: { title: { text: "Fix the parser" } } },
  });
  expect(result.success).toBe(valid);
  expect(result.error?.issues[0]?.path).toEqual(
    valid ? undefined : ["external_ref", "id"],
  );
});

it.each([
  { key: "status", label: "Status", type: "string" },
  { key: "status", label: "Status", type: "string", value: 123 },
  { key: "status", label: "Status", type: "strng", value: "draft" },
  {
    key: "date",
    label: "Created",
    type: "slack#/types/timestamp",
    value: "today",
  },
  { key: "date", label: "Created", type: "slack#/types/timestamp", value: 1.5 },
  {
    key: "date",
    label: "Created",
    type: "slack#/types/timestamp",
    value: 123,
    long: true,
  },
  {
    key: "status",
    label: "Status",
    type: "string",
    value: "draft",
    format: "markdown",
    link: "https://example.com",
  },
])("rejects invalid custom-field contracts: %j", (field) => {
  const result = slackEntitySchema.safeParse({
    entity_type: "slack#/entities/item",
    external_ref: { id: "1" },
    url: "https://example.com/pull/1",
    entity_payload: {
      attributes: { title: { text: "Fix the parser" } },
      custom_fields: [field],
    },
  });
  expect(result.success).toBe(false);
});
