import { tryWorkspaceRepoCheckoutPath } from "./checkout-path";
import type { WorkspaceRepo } from "./types";

const WORKSPACE_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const MAX_SETUP_SCRIPT_BYTES = 64 * 1024;
const MAX_REPOS = 32;

/** Normalized recipe fields accepted by Workspace write paths. */
export interface WorkspaceRecipeInput {
  name: string;
  setupScript: string;
  repos: WorkspaceRepo[];
}

/** Validation failure for one Workspace recipe write. */
export class WorkspaceValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceValidationError";
  }
}

/** Normalize and validate one Workspace recipe write payload. */
export function normalizeWorkspaceRecipe(input: {
  name: string;
  setupScript?: string;
  repos: Array<{
    provider: string;
    repo: string;
    isPrimary?: boolean;
  }>;
}): WorkspaceRecipeInput {
  const name = input.name.trim().toLowerCase();
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw new WorkspaceValidationError(
      "Workspace name must start with a letter and use only lowercase letters, digits, underscores, or hyphens.",
    );
  }

  const setupScript = input.setupScript ?? "";
  if (typeof setupScript !== "string") {
    throw new WorkspaceValidationError("Setup script must be a string.");
  }
  if (Buffer.byteLength(setupScript, "utf8") > MAX_SETUP_SCRIPT_BYTES) {
    throw new WorkspaceValidationError(
      `Setup script must be at most ${MAX_SETUP_SCRIPT_BYTES} bytes.`,
    );
  }

  if (!Array.isArray(input.repos)) {
    throw new WorkspaceValidationError("Repositories must be an array.");
  }
  if (input.repos.length > MAX_REPOS) {
    throw new WorkspaceValidationError(
      `A Workspace can include at most ${MAX_REPOS} repositories.`,
    );
  }

  const repos: WorkspaceRepo[] = input.repos.map((entry, index) => {
    const provider = entry.provider.trim().toLowerCase();
    if (!PROVIDER_PATTERN.test(provider)) {
      throw new WorkspaceValidationError(
        `Repository ${index + 1} provider is invalid.`,
      );
    }
    const repo = entry.repo.trim();
    if (!REPO_PATTERN.test(repo)) {
      throw new WorkspaceValidationError(
        `Repository ${index + 1} must use owner/name format.`,
      );
    }
    if (!tryWorkspaceRepoCheckoutPath(repo)) {
      throw new WorkspaceValidationError(
        `Repository ${index + 1} name cannot be used as a checkout path.`,
      );
    }
    return {
      provider,
      repo,
      isPrimary: entry.isPrimary === true,
    };
  });

  const identities = new Set<string>();
  for (const repo of repos) {
    const identity = `${repo.provider}:${repo.repo.toLowerCase()}`;
    if (identities.has(identity)) {
      throw new WorkspaceValidationError(
        `Duplicate repository in Workspace: ${repo.provider}:${repo.repo}`,
      );
    }
    identities.add(identity);
  }

  const checkoutPaths = new Set<string>();
  for (const repo of repos) {
    const path = tryWorkspaceRepoCheckoutPath(repo.repo)!;
    const key = path.toLowerCase();
    if (checkoutPaths.has(key)) {
      throw new WorkspaceValidationError(
        `Workspace checkout path collision: ${path}`,
      );
    }
    checkoutPaths.add(key);
  }

  const primaryCount = repos.filter((repo) => repo.isPrimary).length;
  if (repos.length > 0 && primaryCount === 0) {
    throw new WorkspaceValidationError(
      "Select one primary repository for AGENTS.md instructions.",
    );
  }
  if (primaryCount > 1) {
    throw new WorkspaceValidationError(
      "A Workspace can have only one primary repository.",
    );
  }

  return { name, setupScript, repos };
}
