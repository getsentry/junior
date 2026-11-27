import { describe, expect, it } from "vitest";
import {
  repositoryUrlKey,
  targetOfUrl,
} from "@/chat/guardian/checkout-records";

describe("checkout records", () => {
  it.each([
    "https://github.com/acme/atlas",
    "https://github.com/acme/atlas.git",
    "https://x-access-token:secret@github.com/acme/atlas.git",
    "ssh://git@github.com/acme/atlas.git",
    "git@github.com:acme/atlas.git",
    "https://GitHub.com/acme/atlas/",
  ])("keys %s as its clone URL", (url) => {
    expect(repositoryUrlKey(url)).toBe("github.com/acme/atlas");
  });

  it.each(["origin", "/tmp/atlas", "file:///tmp/atlas", "https://github.com/"])(
    "gives %s no key",
    (text) => {
      expect(repositoryUrlKey(text)).toBeUndefined();
    },
  );

  it("counts a push URL with no record as world", () => {
    const targets = new Map([
      [
        "github.com/acme/atlas",
        {
          ref: "https://github.com/acme/atlas.git",
          audience: "internal" as const,
        },
      ],
    ]);
    expect(targetOfUrl("git@github.com:acme/atlas.git", targets)).toEqual({
      ref: "https://github.com/acme/atlas.git",
      audience: "internal",
    });
    expect(targetOfUrl("https://github.com/acme/fork.git", targets)).toEqual({
      ref: "https://github.com/acme/fork.git",
      audience: "world",
    });
  });
});
