import { describe, expect, it } from "vitest";

import { conversationInitials } from "../src/client/conversations/conversationIconMark";

describe("conversationInitials", () => {
  it("tells apart names that share a leading word", () => {
    const names = [
      "Junior Spaces",
      "Junior Evals",
      "Junior Infra",
      "Junior Evals Nightly",
    ];

    expect(names.map(conversationInitials)).toEqual(["JS", "JE", "JI", "JN"]);
  });

  it("uses one initial for a one-word name", () => {
    expect(conversationInitials("junior")).toBe("J");
    expect(conversationInitials("  Infra  ")).toBe("I");
  });

  it("splits on the separators that names use for spaces", () => {
    expect(conversationInitials("junior-evals")).toBe("JE");
    expect(conversationInitials("sdk/python")).toBe("SP");
    expect(conversationInitials("ops_on.call")).toBe("OC");
  });

  it("skips words with no letter or digit, and leading punctuation", () => {
    expect(conversationInitials("Billing & payments")).toBe("BP");
    expect(conversationInitials("(beta) Launch")).toBe("BL");
    expect(conversationInitials("Q3 roadmap 🚀")).toBe("QR");
  });

  it("keeps letters outside ASCII", () => {
    expect(conversationInitials("équipe données")).toBe("ÉD");
  });

  it("shows the first character of a name with no letter or digit", () => {
    expect(conversationInitials("🚀")).toBe("🚀");
    expect(conversationInitials("")).toBe("");
  });
});
