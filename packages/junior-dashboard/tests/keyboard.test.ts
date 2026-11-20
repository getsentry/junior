import { describe, expect, it } from "vitest";

import { isPlatformShortcut, platformShortcut } from "../src/client/keyboard";

// Node's user agent is not Apple's, so these use Ctrl.
function key(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: true,
    metaKey: false,
    shiftKey: false,
    ...init,
  } as KeyboardEvent;
}

describe("platform shortcuts", () => {
  it("names a shortcut with or without Alt", () => {
    expect(platformShortcut("k")).toBe("Ctrl K");
    expect(platformShortcut("b", { alt: true })).toBe("Ctrl Alt B");
  });

  it("matches Alt only when the shortcut asks for it", () => {
    expect(isPlatformShortcut(key({ code: "KeyK", key: "k" }), "k")).toBe(true);
    expect(
      isPlatformShortcut(key({ altKey: true, code: "KeyK", key: "k" }), "k"),
    ).toBe(false);
    expect(
      isPlatformShortcut(key({ code: "KeyB", key: "b" }), "b", { alt: true }),
    ).toBe(false);
    // Option changes the typed character, so the physical key matches.
    expect(
      isPlatformShortcut(key({ altKey: true, code: "KeyB", key: "∫" }), "b", {
        alt: true,
      }),
    ).toBe(true);
  });
});
