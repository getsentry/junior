import {
  conversationAnnotationInputSchema,
  objectAnnotationSchema,
  objectFactFields,
  objectPresentation,
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
  it("keeps object identity across lifecycle and warning states", () => {
    for (const [status, icon] of Object.entries({
      open: "git-pull-request",
      draft: "git-pull-request-draft",
      closed: "git-pull-request-closed",
      merged: "git-merge",
      warning: "git-pull-request",
    })) {
      expect(
        objectPresentation({ objectType: "code_change", status }).icon,
      ).toBe(icon);
      expect(objectPresentation({ objectType: "task", status }).icon).not.toBe(
        icon,
      );
    }
    expect(
      objectPresentation({ objectType: "deployment", status: "ERROR" }),
    ).toEqual({ icon: "rocket", tone: "danger", label: "Deployment" });
    expect(
      objectPresentation({ objectType: "item", facts: { type: "deployment" } })
        .label,
    ).toBe("Deployment");
    expect(
      objectPresentation({ objectType: "automation", status: "blocked" }),
    ).toEqual({ icon: "workflow", tone: "warning", label: "Automation" });
    expect(objectPresentation({ objectType: "item" }).icon).toBe("package");
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
    for (const objectType of ["deployment", "item"]) {
      expect(
        objectAnnotationSchema.parse({
          ...card,
          objectType,
          facts: { type: "deployment" },
        }).facts?.type,
      ).toBe("deployment");
    }
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
