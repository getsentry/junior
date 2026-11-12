import { expect } from "vitest";
import { encodeImageId } from "@/chat/images/ids";

/** Match the versioned Junior image path of one Identity photo. */
export function avatarPath(identityId: string) {
  const id = encodeImageId({ ref: identityId, source: "avatar" });
  return expect.stringMatching(
    new RegExp(`^/api/images/${id}\\?w=128&v=[0-9a-f]{16}$`),
  );
}
