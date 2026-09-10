import { describe, expect, it } from "vitest";

import { shouldPreviewImageAttachment } from "../src/client/components/ImageAttachment";

function click(overrides: Partial<Parameters<typeof shouldPreviewImageAttachment>[0]> = {}) {
  return {
    altKey: false,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("ImageAttachment", () => {
  it("previews only unmodified primary clicks", () => {
    expect(shouldPreviewImageAttachment(click())).toBe(true);
    expect(shouldPreviewImageAttachment(click({ ctrlKey: true }))).toBe(false);
    expect(shouldPreviewImageAttachment(click({ metaKey: true }))).toBe(false);
    expect(shouldPreviewImageAttachment(click({ shiftKey: true }))).toBe(false);
    expect(shouldPreviewImageAttachment(click({ altKey: true }))).toBe(false);
    expect(shouldPreviewImageAttachment(click({ button: 1 }))).toBe(false);
    expect(
      shouldPreviewImageAttachment(click({ defaultPrevented: true })),
    ).toBe(false);
  });
});
