function normalizeWorkspaceRoot(input: string | undefined): string {
  const candidate = (input ?? "").trim();
  if (!candidate) {
    return "/vercel/sandbox";
  }

  const normalized = candidate.replace(/\/+$/, "");
  return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

export const SANDBOX_WORKSPACE_ROOT = normalizeWorkspaceRoot(process.env.VERCEL_SANDBOX_WORKSPACE_DIR);
export const SANDBOX_SKILLS_ROOT = `${SANDBOX_WORKSPACE_ROOT}/skills`;

export function sandboxSkillDir(skillName: string): string {
  return `${SANDBOX_SKILLS_ROOT}/${skillName}`;
}

export function sandboxSkillFile(skillName: string): string {
  return `${sandboxSkillDir(skillName)}/SKILL.md`;
}
