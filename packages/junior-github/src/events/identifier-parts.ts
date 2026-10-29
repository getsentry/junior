/** The repository parts that every GitHub identifier starts with. */
export const GITHUB_REPOSITORY_PARTS = {
  owner: {
    kind: "string",
    description: "lowercase GitHub repository owner, such as getsentry",
  },
  repo: {
    kind: "string",
    description: "lowercase GitHub repository name, such as junior",
  },
} as const;
