import { expect } from "vitest";

/** Match the versioned Junior photo path of one Identity. */
export function avatarPath(identityId: string) {
  return expect.stringMatching(
    new RegExp(
      `^/api/people/avatars/${encodeURIComponent(identityId)}\\?v=[0-9a-f]{16}$`,
    ),
  );
}
