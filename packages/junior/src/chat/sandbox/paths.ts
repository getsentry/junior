function normalizeWorkspaceRoot(input: string | undefined): string {
  const candidate = (input ?? "").trim();
  if (!candidate) {
    return "/vercel/sandbox";
  }

  const normalized = candidate.replace(/\/+$/, "");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export const SANDBOX_WORKSPACE_ROOT = normalizeWorkspaceRoot(
  process.env.VERCEL_SANDBOX_WORKSPACE_DIR,
);
export const SANDBOX_REPOS_ROOT = `${SANDBOX_WORKSPACE_ROOT}/repos`;
export const SANDBOX_SKILLS_ROOT = `${SANDBOX_WORKSPACE_ROOT}/skills`;
export const SANDBOX_DATA_ROOT = `${SANDBOX_WORKSPACE_ROOT}/data`;

export function sandboxSkillDir(skillName: string): string {
  return `${SANDBOX_SKILLS_ROOT}/${skillName}`;
}

export function sandboxSkillFile(skillName: string): string {
  return `${sandboxSkillDir(skillName)}/SKILL.md`;
}

/** Explain how the agent should resolve files and commands owned by a skill. */
export function sandboxSkillPathResolution(skillName: string): string {
  const skillDir = sandboxSkillDir(skillName);
  return `Resolve relative paths in this skill against ${skillDir}. For bash commands from this skill, cd to ${skillDir} first or use absolute paths.`;
}
