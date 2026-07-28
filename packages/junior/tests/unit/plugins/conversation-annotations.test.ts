import { conversationAnnotationInputSchema } from "@sentry/junior-plugin-api";
import { describe, expect, it } from "vitest";

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
});
