import type { ConversationDetailReport } from "@sentry/junior/api/schema";
import { describe, expect, it } from "vitest";

import {
  groupSidebarAnnotationsByLabel,
  projectSidebarAnnotationBadges,
} from "../src/client/conversations/sidebarAnnotationBadges";

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

describe("sidebar annotation badge projection", () => {
  it("groups every status icon under one shared label", () => {
    expect(
      groupSidebarAnnotationsByLabel([
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
      {
        label: "getsentry",
        annotations: [
          annotation("getsentry/getsentry#21571", "getsentry", "git-merge"),
          annotation(
            "getsentry/getsentry#21572",
            "getsentry",
            "git-pull-request",
          ),
          annotation(
            "getsentry/getsentry#21569",
            "getsentry",
            "circle-dashed",
          ),
        ],
      },
      {
        label: "sentry",
        annotations: [
          annotation("getsentry/sentry#121727", "sentry", "git-merge"),
        ],
      },
    ]);
  });

  it("keeps up to two labels fully expanded", () => {
    expect(
      projectSidebarAnnotationBadges([
        annotation("a#1", "alpha", "circle-dot"),
        annotation("a#2", "alpha", "git-merge"),
        annotation("b#1", "beta", "circle-dashed"),
      ]),
    ).toEqual({
      groups: [
        {
          label: "alpha",
          annotations: [
            annotation("a#1", "alpha", "circle-dot"),
            annotation("a#2", "alpha", "git-merge"),
          ],
        },
        {
          label: "beta",
          annotations: [annotation("b#1", "beta", "circle-dashed")],
        },
      ],
      labeledGroups: [
        {
          label: "alpha",
          annotations: [
            annotation("a#1", "alpha", "circle-dot"),
            annotation("a#2", "alpha", "git-merge"),
          ],
        },
        {
          label: "beta",
          annotations: [annotation("b#1", "beta", "circle-dashed")],
        },
      ],
      overflowGroupCount: 0,
    });
  });

  it("keeps the first two labels and collapses the rest behind +N", () => {
    expect(
      projectSidebarAnnotationBadges([
        annotation("a#1", "alpha", "circle-dot"),
        annotation("a#2", "alpha", "git-merge"),
        annotation("b#1", "beta", "circle-dashed"),
        annotation("c#1", "gamma", "git-pull-request"),
        annotation("c#2", "gamma", "circle-x"),
      ]),
    ).toEqual({
      groups: [
        {
          label: "alpha",
          annotations: [
            annotation("a#1", "alpha", "circle-dot"),
            annotation("a#2", "alpha", "git-merge"),
          ],
        },
        {
          label: "beta",
          annotations: [annotation("b#1", "beta", "circle-dashed")],
        },
        {
          label: "gamma",
          annotations: [
            annotation("c#1", "gamma", "git-pull-request"),
            annotation("c#2", "gamma", "circle-x"),
          ],
        },
      ],
      labeledGroups: [
        {
          label: "alpha",
          annotations: [
            annotation("a#1", "alpha", "circle-dot"),
            annotation("a#2", "alpha", "git-merge"),
          ],
        },
        {
          label: "beta",
          annotations: [annotation("b#1", "beta", "circle-dashed")],
        },
      ],
      overflowGroupCount: 1,
    });
  });
});
