import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

export interface HomeConfig {
  bot: {
    name: string;
  };
  ai: {
    model: string;
    fast_model: string;
  };
}

export function homeDir(): string {
  const dir = process.env.JUNIOR_HOME ?? process.cwd();
  return path.resolve(dir);
}

export function soulPath(): string {
  return path.join(homeDir(), "SOUL.md");
}

export function skillsDir(): string {
  return path.join(homeDir(), "skills");
}

export function loadHomeConfig(): HomeConfig {
  const configPath = path.join(homeDir(), "config.toml");
  const raw = fs.readFileSync(configPath, "utf8");
  const parsed = parseToml(raw);

  const bot = parsed.bot as { name?: string } | undefined;
  const ai = parsed.ai as { model?: string; fast_model?: string } | undefined;

  return {
    bot: {
      name: (bot?.name as string) ?? "junior"
    },
    ai: {
      model: (ai?.model as string) ?? "anthropic/claude-sonnet-4.6",
      fast_model: (ai?.fast_model as string) ?? "anthropic/claude-haiku-4-5"
    }
  };
}
