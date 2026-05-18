/** Virtual module injected by juniorNitro() at build time. */
declare module "#junior/config" {
  export const enabledPlatforms: string[] | undefined;
  export const pluginPackages: string[];
  export const platforms:
    | import("@/chat/platform-config").JuniorPlatformOptionsMap
    | undefined;
}
