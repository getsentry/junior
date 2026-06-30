export type GitHubAppPermissionLevel = "admin" | "read" | "write";
export type GitHubAppPermissions = Record<string, GitHubAppPermissionLevel>;
/** Validate configured GitHub App permissions before using them in grants. */
export declare function normalizePermissions(permissions: GitHubAppPermissions | undefined): GitHubAppPermissions | undefined;
/** Build the read-only installation-token permission body. */
export declare function readGrantPermissions(permissions: Record<string, unknown> | undefined): Record<string, "read">;
/** Expose configured permissions as plugin capabilities for host policy checks. */
export declare function permissionCapabilities(permissions: GitHubAppPermissions | undefined): string[] | undefined;
