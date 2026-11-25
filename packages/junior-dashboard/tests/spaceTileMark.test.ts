import { describe, expect, it } from "vitest";

import {
  spaceInitials,
  spaceTileColor,
} from "../src/client/spaces/spaceTileMark";

describe("spaceInitials", () => {
  it("tells apart names that share a leading word", () => {
    const names = [
      "Junior Spaces",
      "Junior Evals",
      "Junior Infra",
      "Junior Evals Nightly",
    ];

    expect(names.map(spaceInitials)).toEqual(["JS", "JE", "JI", "JN"]);
  });

  it("uses one initial for a one-word name", () => {
    expect(spaceInitials("junior")).toBe("J");
    expect(spaceInitials("  Infra  ")).toBe("I");
  });

  it("splits on the separators that names use for spaces", () => {
    expect(spaceInitials("junior-evals")).toBe("JE");
    expect(spaceInitials("sdk/python")).toBe("SP");
    expect(spaceInitials("ops_on.call")).toBe("OC");
  });

  it("skips words with no letter or digit, and leading punctuation", () => {
    expect(spaceInitials("Billing & payments")).toBe("BP");
    expect(spaceInitials("(beta) Launch")).toBe("BL");
    expect(spaceInitials("Q3 roadmap 🚀")).toBe("QR");
  });

  it("keeps letters outside ASCII", () => {
    expect(spaceInitials("équipe données")).toBe("ÉD");
  });

  it("shows the first character of a name with no letter or digit", () => {
    expect(spaceInitials("🚀")).toBe("🚀");
    expect(spaceInitials("")).toBe("");
  });
});

describe("spaceTileColor", () => {
  it("gives a Space the same color on every call", () => {
    const id = "6f1c2a7e-3b4d-4e5f-8a6b-7c8d9e0f1a21";

    expect(spaceTileColor(id)).toBe(spaceTileColor(id));
  });

  it("spreads IDs that differ in one character over the palette", () => {
    const ids = Array.from(
      { length: 1200 },
      (_, index) =>
        `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    );
    const counts = new Map<string, number>();
    for (const id of ids) {
      const color = spaceTileColor(id);
      counts.set(color, (counts.get(color) ?? 0) + 1);
    }

    expect(counts.size).toBe(12);
    for (const count of counts.values()) {
      expect(count).toBeGreaterThan(50);
      expect(count).toBeLessThan(150);
    }
  });
});
