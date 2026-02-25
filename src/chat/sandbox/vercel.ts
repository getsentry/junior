import fs from "node:fs/promises";
import path from "node:path";
import { Sandbox } from "@vercel/sandbox";
import type { SkillMetadata } from "@/chat/skills";

interface SandboxExecutionInput {
  toolName: string;
  input: unknown;
}

export interface SandboxGeneratedFile {
  dataBase64: string;
  filename: string;
  mimeType: string;
}

interface SkillStatePatch {
  activeSkillName?: string;
}

export interface SandboxExecutionEnvelope<T = unknown> {
  result: T;
  generatedFiles?: SandboxGeneratedFile[];
  artifactStatePatch?: Record<string, unknown>;
  skillStatePatch?: SkillStatePatch;
}

export function isVercelSandboxEnabled(): boolean {
  return process.env.VERCEL_SANDBOX_ENABLED === "1";
}

function resolveCredentials(): { token: string; teamId?: string } | null {
  const token = process.env.VERCEL_SANDBOX_TOKEN;
  if (!token) return null;
  return {
    token,
    teamId: process.env.VERCEL_SANDBOX_TEAM_ID
  };
}

function toPosixRelative(base: string, absolute: string): string {
  return path.relative(base, absolute).split(path.sep).join("/");
}

function buildSandboxScript(): string {
  return `
const fs = require('node:fs/promises');
const { spawn } = require('node:child_process');
const path = require('node:path');

const payload = JSON.parse(process.env.PAYLOAD || '{}');
const timeout = (promise, ms) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
]);

const decode = (s) => String(s)
  .replaceAll('&amp;', '&')
  .replaceAll('&lt;', '<')
  .replaceAll('&gt;', '>')
  .replaceAll('&quot;', '"')
  .replaceAll('&#39;', "'");

function stripFrontmatter(raw) {
  if (!raw.startsWith('---')) return raw;
  const match = /^---\\n[\\s\\S]*?\\n---\\n?/.exec(raw);
  if (!match) return raw;
  return raw.slice(match[0].length);
}

async function loadSkillIndex() {
  const raw = await fs.readFile('/workspace/skills/index.json', 'utf8');
  return JSON.parse(raw);
}

function normalizeSkillToken(value) {
  return String(value || '').trim().toLowerCase();
}

async function runLoadSkill(input) {
  const skillName = String(input.skill_name || '').trim();
  const normalized = normalizeSkillToken(skillName);
  const index = await loadSkillIndex();
  const found = index.skills.find((skill) => normalizeSkillToken(skill.name) === normalized) || null;
  if (!found) {
    return {
      result: {
        ok: false,
        error: 'Unknown skill: ' + skillName,
        available_skills: index.skills.map((skill) => skill.name),
      },
    };
  }

  const raw = await fs.readFile(path.join(found.root, 'SKILL.md'), 'utf8');
  return {
    result: {
      ok: true,
      skill_name: found.name,
      description: found.description,
      skill_dir: found.root,
      location: found.root + '/SKILL.md',
      instructions: stripFrontmatter(raw),
    },
    skillStatePatch: {
      activeSkillName: found.name,
    },
  };
}

function extFor(mimeType) {
  if (mimeType === 'image/png') return 'png';
  if (mimeType === 'image/jpeg') return 'jpg';
  if (mimeType === 'image/webp') return 'webp';
  if (mimeType === 'image/gif') return 'gif';
  return 'bin';
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  const int = Math.floor(number);
  if (int < min) return min;
  if (int > max) return max;
  return int;
}

function appendWithLimit(current, chunk, limit) {
  if (!chunk) return { text: current, truncated: false };
  if (current.length >= limit) {
    return { text: current, truncated: true };
  }

  const remaining = limit - current.length;
  if (chunk.length <= remaining) {
    return { text: current + chunk, truncated: false };
  }

  return {
    text: current + chunk.slice(0, remaining),
    truncated: true,
  };
}

async function runBash(input) {
  const command = String(input.command || '').trim();
  if (!command) {
    throw new Error('command is required');
  }

  const timeoutMs = clampInt(input.timeout_ms, 100, 300000, 120000);
  const maxOutputChars = clampInt(input.max_output_chars, 200, 200000, 12000);

  return await new Promise((resolve, reject) => {
    const child = spawn('bash', ['-lc', command], {
      cwd: '/workspace',
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      const next = appendWithLimit(stdout, String(chunk), maxOutputChars);
      stdout = next.text;
      if (next.truncated) stdoutTruncated = true;
    });

    child.stderr.on('data', (chunk) => {
      const next = appendWithLimit(stderr, String(chunk), maxOutputChars);
      stderr = next.text;
      if (next.truncated) stderrTruncated = true;
    });

    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        result: {
          ok: code === 0 && !timedOut,
          command,
          cwd: '/workspace',
          exit_code: code ?? -1,
          signal: signal || null,
          timed_out: timedOut,
          stdout,
          stderr,
          stdout_truncated: stdoutTruncated,
          stderr_truncated: stderrTruncated,
        },
      });
    });
  });
}

async function runWebSearch(input) {
  const q = encodeURIComponent(String(input.query || ''));
  const html = await timeout(
    fetch('https://duckduckgo.com/html/?q=' + q).then((r) => r.text()),
    10000
  );
  const out = [];
  const max = Math.max(1, Math.min(Number(input.max_results || 3), 5));
  const re = /<a[^>]*class=\\"result__a\\"[^>]*href=\\"([^\\"]+)\\"[^>]*>([\\s\\S]*?)<\\/a>[\\s\\S]*?<a[^>]*class=\\"result__snippet\\"[^>]*>([\\s\\S]*?)<\\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < max) {
    out.push({
      url: decode(m[1]),
      title: decode(m[2].replace(/<[^>]+>/g, '').trim()),
      snippet: decode(m[3].replace(/<[^>]+>/g, '').trim()),
    });
  }
  return {
    result: {
      ok: true,
      query: String(input.query || ''),
      result_count: out.length,
      results: out,
    },
  };
}

async function runWebFetch(input) {
  const response = await timeout(fetch(String(input.url)), 10000);
  const text = await timeout(response.text(), 10000);
  const maxChars = Math.max(500, Math.min(Number(input.max_chars || 6000), 20000));
  return {
    result: {
      url: String(input.url),
      content: text.slice(0, maxChars),
    },
  };
}

async function runImageGenerate(input) {
  const apiKey = process.env.AI_GATEWAY_API_KEY;
  if (!apiKey) {
    throw new Error('AI_GATEWAY_API_KEY is required for image_generate');
  }

  const response = await timeout(
    fetch('https://ai-gateway.vercel.sh/v1/images/generations', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer ' + apiKey,
      },
      body: JSON.stringify({
        model: 'google/gemini-3-pro-image',
        prompt: String(input.prompt || ''),
      }),
    }),
    20000
  );

  if (!response.ok) {
    throw new Error('image generation failed: ' + response.status + ' ' + (await response.text()));
  }

  const payload = await response.json();
  const generatedFiles = [];
  const data = Array.isArray(payload.data) ? payload.data : [];
  for (let i = 0; i < data.length; i++) {
    const image = data[i] || {};
    let base64 = '';
    let mimeType = typeof image.mime_type === 'string' && image.mime_type ? image.mime_type : 'image/png';

    if (typeof image.b64_json === 'string' && image.b64_json.length > 0) {
      base64 = image.b64_json;
    } else if (typeof image.url === 'string' && image.url.length > 0) {
      const fetched = await timeout(fetch(image.url), 10000);
      if (!fetched.ok) continue;
      mimeType = fetched.headers.get('content-type') || mimeType;
      const bytes = Buffer.from(await fetched.arrayBuffer());
      base64 = bytes.toString('base64');
    }

    if (!base64) continue;
    generatedFiles.push({
      dataBase64: base64,
      filename: 'generated-image-' + Date.now() + '-' + (i + 1) + '.' + extFor(mimeType),
      mimeType,
    });
  }

  return {
    result: {
      ok: true,
      model: 'google/gemini-3-pro-image',
      prompt: String(input.prompt || ''),
      image_count: generatedFiles.length,
      images: generatedFiles.map((file) => ({
        filename: file.filename,
        media_type: file.mimeType,
      })),
      delivery: 'Images will be attached to the Slack response as files.',
    },
    generatedFiles,
  };
}

async function main() {
  const toolName = String(payload.toolName || '');
  const input = payload.input || {};

  if (toolName === 'web_search') return runWebSearch(input);
  if (toolName === 'web_fetch') return runWebFetch(input);
  if (toolName === 'image_generate') return runImageGenerate(input);
  if (toolName === 'load_skill') return runLoadSkill(input);
  if (toolName === 'bash') return runBash(input);

  throw new Error('unsupported sandbox tool: ' + toolName);
}

main()
  .then((envelope) => {
    process.stdout.write(JSON.stringify({ ok: true, envelope }));
  })
  .catch((error) => {
    process.stderr.write(String(error && error.message ? error.message : error));
    process.exit(1);
  });
`;
}

function isSkillTool(toolName: string): boolean {
  return toolName === "load_skill" || toolName === "bash";
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const queue: string[] = [root];
  const files: string[] = [];

  while (queue.length > 0) {
    const dir = queue.shift() as string;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
      } else if (entry.isFile()) {
        files.push(absolute);
      }
    }
  }

  return files;
}

export class VercelSandboxToolExecutor {
  private sandbox: Sandbox | null = null;
  private availableSkills: SkillMetadata[] = [];
  private skillsSynced = false;
  private activeSkillName: string | undefined;
  private sandboxIdHint?: string;
  private readonly timeoutMs: number;

  constructor(options?: {
    sandboxId?: string;
    timeoutMs?: number;
  }) {
    this.sandboxIdHint = options?.sandboxId;
    this.timeoutMs = options?.timeoutMs ?? 1000 * 60 * 30;
  }

  getSandboxId(): string | undefined {
    return this.sandbox?.sandboxId ?? this.sandboxIdHint;
  }

  configureSkills(skills: SkillMetadata[]): void {
    this.availableSkills = [...skills];
    this.skillsSynced = false;
  }

  canExecute(toolName: string): boolean {
    return (
      isVercelSandboxEnabled() &&
      (toolName === "web_fetch" ||
        toolName === "web_search" ||
        toolName === "image_generate" ||
        toolName === "load_skill" ||
        toolName === "bash")
    );
  }

  private async getSandbox(): Promise<Sandbox> {
    if (this.sandbox) return this.sandbox;

    const credentials = resolveCredentials();
    if (!credentials) {
      throw new Error("VERCEL_SANDBOX_TOKEN is required when VERCEL_SANDBOX_ENABLED=1");
    }

    if (this.sandboxIdHint) {
      try {
        this.sandbox = await Sandbox.get({
          sandboxId: this.sandboxIdHint,
          token: credentials.token,
          teamId: credentials.teamId
        });
      } catch {
        this.sandbox = null;
      }
    }

    if (!this.sandbox) {
      this.sandbox = await Sandbox.create({
        timeout: this.timeoutMs,
        runtime: "node22",
        token: credentials.token,
        teamId: credentials.teamId
      });
    }

    this.sandboxIdHint = this.sandbox.sandboxId;

    return this.sandbox;
  }

  private async ensureSkillsSynced(): Promise<void> {
    if (this.skillsSynced) return;
    const sandbox = await this.getSandbox();

    if (this.availableSkills.length === 0) {
      await sandbox.writeFiles([
        {
          path: "/workspace/skills/index.json",
          content: Buffer.from(JSON.stringify({ skills: [] }), "utf8")
        }
      ]);
      this.skillsSynced = true;
      return;
    }

    const filesToWrite: Array<{ path: string; content: Buffer }> = [];
    const index = {
      skills: [] as Array<{
        name: string;
        description: string;
        root: string;
      }>
    };

    for (const skill of this.availableSkills) {
      const skillFiles = await listFilesRecursive(skill.skillPath);
      for (const absoluteFile of skillFiles) {
        const relative = toPosixRelative(skill.skillPath, absoluteFile);
        if (!relative || relative.startsWith("..")) continue;

        const content = await fs.readFile(absoluteFile);
        filesToWrite.push({
          path: `/workspace/skills/${skill.name}/${relative}`,
          content
        });
      }

      index.skills.push({
        name: skill.name,
        description: skill.description,
        root: `/workspace/skills/${skill.name}`
      });
    }

    filesToWrite.push({
      path: "/workspace/skills/index.json",
      content: Buffer.from(JSON.stringify(index), "utf8")
    });

    await sandbox.writeFiles(filesToWrite);
    this.skillsSynced = true;
  }

  async execute<T>(params: SandboxExecutionInput): Promise<SandboxExecutionEnvelope<T>> {
    const sandbox = await this.getSandbox();
    const keepAliveMs = Number.parseInt(process.env.VERCEL_SANDBOX_KEEPALIVE_MS ?? "0", 10);
    if (Number.isFinite(keepAliveMs) && keepAliveMs > 0) {
      try {
        await sandbox.extendTimeout(keepAliveMs);
      } catch {
        // Best effort keepalive.
      }
    }

    if (isSkillTool(params.toolName)) {
      await this.ensureSkillsSynced();
    }

    const payload = JSON.stringify({
      ...params,
      skillState: {
        activeSkillName: this.activeSkillName
      }
    });

    const command = await sandbox.runCommand({
      cmd: "node",
      args: ["-e", buildSandboxScript()],
      env: {
        PAYLOAD: payload,
        AI_GATEWAY_API_KEY: process.env.AI_GATEWAY_API_KEY ?? ""
      }
    });

    if (command.exitCode !== 0) {
      const stderr = await command.stderr();
      throw new Error(stderr || "Sandbox command failed");
    }

    const stdout = await command.stdout();
    const parsed = JSON.parse(stdout) as { ok: boolean; envelope: SandboxExecutionEnvelope<T> };
    if (parsed.envelope.skillStatePatch?.activeSkillName) {
      this.activeSkillName = parsed.envelope.skillStatePatch.activeSkillName;
    }
    return parsed.envelope;
  }

  async dispose(): Promise<void> {
    if (!this.sandbox) return;
    await this.sandbox.stop({ blocking: true });
    this.sandbox = null;
    this.skillsSynced = false;
    this.activeSkillName = undefined;
  }
}
