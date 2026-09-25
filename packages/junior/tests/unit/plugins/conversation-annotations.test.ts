import {
  conversationAnnotationInputSchema,
  objectAnnotationSchema,
  objectFactFields,
} from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

describe("conversation annotations", () => {
  it("only accepts HTTP and HTTPS resource links", () => {
    const annotation = {
      kind: "resource_link" as const,
      key: "getsentry/junior#1081",
      label: "getsentry/junior #1081",
    };

    expect(() =>
      conversationAnnotationInputSchema.parse({
        ...annotation,
        url: "javascript:alert(1)",
      }),
    ).toThrow("URL must use HTTP or HTTPS.");
    expect(
      conversationAnnotationInputSchema.parse({
        ...annotation,
        url: "https://github.com/getsentry/junior/pull/1081",
      }),
    ).toMatchObject(annotation);
  });
  it("bounds typed object facts without rejecting old cards or accepting arbitrary provider JSON", () => {
    const card = {
      kind: "object",
      objectType: "task",
      key: "ENG-1",
      label: "ENG-1",
      title: "Fix cards",
      url: null,
    };
    expect(objectAnnotationSchema.parse(card)).toEqual(card);
    const parse = (facts: unknown) =>
      objectAnnotationSchema.parse({ ...card, facts });
    expect(parse({ type: "task", assignees: [] }).facts).toEqual({
      type: "task",
      assignees: [],
    });
    expect(() =>
      parse({ type: "task", labels: Array(6).fill("label") }),
    ).toThrow(ZodError);
    expect(() => parse({ type: "task", priority: "x".repeat(161) })).toThrow(
      ZodError,
    );
    expect(() => parse({ type: "task", env: { TOKEN: "secret" } })).toThrow(
      ZodError,
    );
    expect(() => parse({ type: "code_change", author: "alex" })).toThrow(
      "Object facts must match",
    );
    expect(() =>
      parse({
        type: "task",
        labels: Array(5).fill("界".repeat(160)),
        assignees: Array(5).fill("界".repeat(160)),
      }),
    ).toThrow("4 KiB");
    expect(objectFactFields(undefined)).toEqual([]);
    expect(objectFactFields({ type: "code_change" })).toEqual([]);
    expect(objectFactFields({ type: "task", assignees: [] })).toEqual([
      { key: "assignees", label: "Assignees", value: "Unassigned" },
    ]);
  });
});
