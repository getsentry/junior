import type { CapabilityTarget } from "@/chat/capabilities/types";

const REPO_FLAG_RE = /(?:^|\s)--repo(?:\s+|=)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:#[0-9]+)?)/;

export function parseRepoTarget(value: string): { owner: string; repo: string } | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  const [repoRef] = trimmed.split("#");
  const [owner, repo] = repoRef.split("/");
  if (!owner || !repo) {
    return undefined;
  }

  return {
    owner: owner.toLowerCase(),
    repo: repo.toLowerCase()
  };
}

function extractRepoRef(text: string): { owner: string; repo: string } | undefined {
  const byFlag = REPO_FLAG_RE.exec(text);
  if (byFlag) {
    return parseRepoTarget(byFlag[1]);
  }

  return undefined;
}

export function extractCapabilityTarget(params: {
  skillName: string;
  commandText: string;
  invocationArgs?: string;
}): CapabilityTarget | undefined {
  if (!params.skillName.startsWith("gh-")) {
    return undefined;
  }

  const commandRepo = extractRepoRef(params.commandText);
  if (commandRepo) {
    return commandRepo;
  }

  if (params.invocationArgs) {
    const invocationRepo = extractRepoRef(params.invocationArgs);
    if (invocationRepo) {
      return invocationRepo;
    }
  }

  return undefined;
}
