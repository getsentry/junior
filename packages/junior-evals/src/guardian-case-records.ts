/**
 * The stored records that production has for a single-call case: the
 * repositories that GitHub reports as private, and the code-change and
 * Workspace records that the case's own tool results created.
 */
import type { ToolActionProposal } from "@/chat/guardian/proposal";
import type { GuardianDesignFacts } from "./guardian-design-harness";

// Cases name real getsentry repositories. GitHub reports these as private
// or internal; it reports the others that the cases name as public.
const PRIVATE_REPOS = [
  "getsentry/getsentry",
  "getsentry/junior-prod",
  "getsentry/ops",
  "getsentry/seer",
];

const REF = /\b([\w.-]+\/[\w.-]+)#(\d+)\b/;
const PULL_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/;
const BRANCH = /\bfrom (\S+) to \S+/;
// An `owner/name` that is not part of a path.
const REPO = /(?<![\w./-])([\w.-]+\/[\w.-]+)(?![\w/])/;

/** A string field of a JSON tool result. */
function field(text: string, name: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (value && typeof value === "object" && name in value) {
      const found = (value as Record<string, unknown>)[name];
      return typeof found === "string" ? found : undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function createdPullRequest(text: string) {
  const url = field(text, "url") ?? text;
  const match = PULL_URL.exec(url) ?? REF.exec(text);
  if (!match) return undefined;
  const branch = BRANCH.exec(text)?.[1];
  return { ref: `${match[1]}#${match[2]}`, branch };
}

/**
 * The records of a single-call case: what its own tool results created,
 * merged with what the case states.
 */
export function caseRecords(
  proposal: ToolActionProposal,
  stated: GuardianDesignFacts | undefined,
): GuardianDesignFacts {
  const ownPullRequests = new Set(stated?.ownPullRequests);
  const pullRequestBranches = { ...stated?.pullRequestBranches };
  const workspaceRepos = new Set(stated?.workspaceRepos);
  for (const { role, text } of proposal.evidence?.entries ?? []) {
    if (
      role === "tool github_createPullRequest result" &&
      !text.startsWith("The action was not executed")
    ) {
      const created = createdPullRequest(text);
      if (!created) continue;
      ownPullRequests.add(created.ref);
      if (created.branch) pullRequestBranches[created.ref] ??= created.branch;
    }
    if (role === "tool github_cloneRepository result") {
      const repo = field(text, "repo") ?? REPO.exec(text)?.[1];
      if (repo) workspaceRepos.add(repo);
    }
  }
  return {
    ...stated,
    ownPullRequests: [...ownPullRequests],
    privateRepos: [
      ...new Set([...PRIVATE_REPOS, ...(stated?.privateRepos ?? [])]),
    ],
    pullRequestBranches,
    workspaceRepos: [...workspaceRepos],
  };
}
