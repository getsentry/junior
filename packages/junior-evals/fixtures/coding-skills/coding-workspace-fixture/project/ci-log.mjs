// A later CI artifact for the resource access investigation.
const failedCheck = {
  check: "tests/api/resources/test_access.py::test_resource_21_115",
  organization: "org-red",
  project: "project-red",
  resource: "resource-115",
  expected: 404,
  observed: 200,
};

console.log(
  JSON.stringify({ suite: "resource access", status: "failed", failedCheck }),
);

for (const index of Array.from({ length: 220 }, (_, offset) => offset + 1)) {
  console.log(
    JSON.stringify({
      check: `tests/api/resources/test_scope.py::test_resource_scope_${index}`,
      organization: index % 2 ? "org-red" : "org-blue",
      project: index % 3 ? "project-red" : "project-blue",
      resource: `resource-${index}`,
      expected: 200,
      observed: 200,
      status: "passed",
    }),
  );
}
