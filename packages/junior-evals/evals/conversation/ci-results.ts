import type { HistoryToolCall } from "@junior-evals/fixture/inputs";

const SHARDS = 20;
const CHECKS_PER_SHARD = 230;
const MODULES = ["resources", "projects", "permissions", "audit"] as const;

/** Earlier CI work with one cross-organization access failure. */
export function validationLogs(): HistoryToolCall[] {
  return Array.from({ length: SHARDS }, (_, shard) => {
    const lines = Array.from({ length: CHECKS_PER_SHARD }, (_, check) => {
      const module = MODULES[(shard + check) % MODULES.length];
      const location = `tests/api/${module}/test_access.py::test_resource_${shard + 1}_${check + 1}`;
      if (shard === 10 && check === 114) {
        return `${location} FAIL org=org-red project=project-red resource=resource-115 expected=404 observed=200; lookup filtered by resource id only and returned the row owned by org-blue`;
      }
      return `${location} PASS org=org-red project=project-red resource=resource-${shard + 1}-${check + 1} expected=200 observed=200 duration=${((check % 17) + 1) / 100}s`;
    });
    return {
      name: "bash",
      arguments: { command: `pnpm test --shard=${shard + 1}/${SHARDS}` },
      result: {
        exit_code: shard === 10 ? 1 : 0,
        stdout: lines.join("\n"),
        stderr: "",
        timed_out: false,
      },
    };
  });
}
