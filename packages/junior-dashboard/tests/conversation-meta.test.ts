import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { describe, expect, it } from "vitest";

import { collapseSidebarAnnotationStack } from "../src/client/conversations/ConversationMeta";

type SidebarAnnotation = NonNullable<
  ConversationDetailReport["sidebarAnnotations"]
>[number];

function annotation(
  key: string,
  label: string,
  icon: NonNullable<SidebarAnnotation["icon"]>,
): SidebarAnnotation {
  return { icon, key, label };
}

describe("conversation sidebar annotation stack", () => {
  it("prefers unfinished work when a label has finished and unfinished work", () => {
    expect(
      collapseSidebarAnnotationStack([
        annotation("getsentry/getsentry#21571", "getsentry", "git-merge"),
        annotation(
          "getsentry/getsentry#21572",
          "getsentry",
          "git-pull-request",
        ),
        annotation("getsentry/getsentry#21569", "getsentry", "circle-dashed"),
        annotation("getsentry/sentry#121727", "sentry", "git-merge"),
      ]),
    ).toEqual([
      annotation("getsentry/getsentry#21572", "getsentry", "git-pull-request"),
      annotation("getsentry/sentry#121727", "sentry", "git-merge"),
    ]);
  });
});
