import { readFileSync } from "node:fs";
import path from "node:path";
import { homeDir } from "@/chat/discovery";
import { discoverInstalledPluginPackageContent } from "@/chat/plugins/package-discovery";
import { getPluginProviders } from "@/chat/plugins/registry";
import { discoverSkills } from "@/chat/skills";

function readDescriptionText(): string | undefined {
  try {
    const raw = readFileSync(
      path.join(homeDir(), "DESCRIPTION.md"),
      "utf8",
    ).trim();
    return raw || undefined;
  } catch {
    return undefined;
  }
}

/** Return a runtime discovery snapshot for built-app diagnostics. */
export async function GET(): Promise<Response> {
  const packagedContent = discoverInstalledPluginPackageContent();
  const skills = await discoverSkills();

  return Response.json({
    cwd: process.cwd(),
    homeDir: homeDir(),
    descriptionText: readDescriptionText(),
    providers: getPluginProviders().map((plugin) => plugin.manifest.name),
    skills: skills.map((skill) => ({
      name: skill.name,
      pluginProvider: skill.pluginProvider,
    })),
    packagedContent,
  });
}
