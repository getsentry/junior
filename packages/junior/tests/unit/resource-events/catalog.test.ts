import { describe, expect, it } from "vitest";
import {
  resourceEventGuidance,
  type ResourceEventCatalog,
} from "@/chat/resource-events/catalog";

const catalog: ResourceEventCatalog = {
  github: {
    resourceTypes: [
      {
        type: "pull_request",
        supportedEvents: ["pull_request.comment.created"],
        guidance: {
          "pull_request.comment.created": "Address actionable feedback.",
        },
      },
      {
        type: "repository",
        supportedEvents: ["pull_request.comment.created"],
      },
    ],
  },
};

describe("resource event catalog", () => {
  it("scopes app guidance to the registered resource type", () => {
    expect(
      resourceEventGuidance(
        catalog,
        "github",
        "pull_request",
        "pull_request.comment.created",
      ),
    ).toBe("Address actionable feedback.");
    expect(
      resourceEventGuidance(
        catalog,
        "github",
        "repository",
        "pull_request.comment.created",
      ),
    ).toBeUndefined();
  });
});
