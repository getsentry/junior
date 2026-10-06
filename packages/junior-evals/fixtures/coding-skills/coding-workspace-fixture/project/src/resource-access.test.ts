import assert from "node:assert/strict";
import { test } from "node:test";
import { getResource, type Resource } from "./resource-access.ts";

const rows: Resource[] = [
  { id: "resource-115", organizationId: "org-blue", projectId: "project-red" },
  { id: "resource-115", organizationId: "org-red", projectId: "project-blue" },
  { id: "resource-115", organizationId: "org-red", projectId: "project-red" },
];

test("resource lookup stays within the organization and project", () => {
  assert.equal(
    getResource(rows, "org-red", "project-red", "resource-115"),
    rows[2],
  );
  assert.equal(
    getResource(rows.slice(0, 2), "org-red", "project-red", "resource-115"),
    undefined,
  );
});
