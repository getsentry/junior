type ContributionLevel = 0 | 1 | 2 | 3 | 4;

/** Bucket a daily count into a GitHub-style contribution level. */
export function contributionLevel(
  count: number,
  max: number,
): ContributionLevel {
  if (count <= 0) return 0;
  const ratio = count / max;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.45) return 3;
  if (ratio >= 0.2) return 2;
  return 1;
}

/** Fill one contribution cell with the GitHub green for its level. */
export function contributionLevelClass(level: ContributionLevel): string {
  return {
    0: "bg-dashboard-surface-hover",
    1: "bg-[#133225] light:bg-[#9be9a8]",
    2: "bg-[#176a4a] light:bg-[#40c463]",
    3: "bg-[#22a06b] light:bg-[#30a14e]",
    4: "bg-[#8bdc97] light:bg-[#216e39]",
  }[level];
}
