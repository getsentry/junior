import { vi } from "vitest";

type SandboxCreateOptions = {
  name?: string;
  persistent?: boolean;
  source?: { type: "snapshot"; snapshotId: string };
};

type CommandResult = {
  exitCode: number;
  stdout(): Promise<string>;
  stderr(): Promise<string>;
};

function commandResult(): CommandResult {
  return {
    exitCode: 0,
    stdout: async () => "",
    stderr: async () => "",
  };
}

function sandbox(name: string) {
  const fs = {
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => undefined),
    readdir: vi.fn(async () => [] as string[]),
    stat: vi.fn(async () => ({ isDirectory: () => false })),
  };
  const session = {
    sessionId: `${name}-session`,
    fs,
    extendTimeout: vi.fn(async () => undefined),
    mkDir: vi.fn(async () => undefined),
    readFileToBuffer: vi.fn(async () => null),
    runCommand: vi.fn(async () => commandResult()),
    snapshot: vi.fn(async () => vercelSandboxFixture.nextSnapshot()),
    stop: vi.fn(async () => undefined),
    update: vi.fn(async () => undefined),
    writeFiles: vi.fn(async () => undefined),
  };
  return {
    name,
    session,
    currentSession: () => session,
    extendTimeout: vi.fn(async () => undefined),
    getCommand: vi.fn(async () => commandResult()),
    runCommand: vi.fn(async () => ({ cmdId: `${name}-setup` })),
    snapshot: vi.fn(async () => vercelSandboxFixture.nextSnapshot()),
    stop: vi.fn(async () => undefined),
  };
}

export const vercelSandboxFixture = {
  createCalls: [] as SandboxCreateOptions[],
  sandboxes: new Map<string, ReturnType<typeof sandbox>>(),
  snapshotCount: 0,
  reset() {
    this.createCalls.length = 0;
    this.sandboxes.clear();
    this.snapshotCount = 0;
  },
  nextSnapshot() {
    this.snapshotCount += 1;
    return { snapshotId: `workspace-snapshot-${this.snapshotCount}` };
  },
  create(options: SandboxCreateOptions) {
    this.createCalls.push(options);
    const name = options.name ?? `runtime-sandbox-${this.createCalls.length}`;
    const created = sandbox(name);
    this.sandboxes.set(name, created);
    return created;
  },
  get(name: string) {
    const found = this.sandboxes.get(name);
    if (!found) throw new Error(`Sandbox not found: ${name}`);
    return found;
  },
  snapshotBoots(): string[] {
    return this.createCalls.flatMap((call) =>
      call.source?.type === "snapshot" ? [call.source.snapshotId] : [],
    );
  },
  persistentSandboxes() {
    return this.createCalls.flatMap((call) => {
      if (!call.persistent || !call.name) return [];
      const found = this.sandboxes.get(call.name);
      return found ? [found] : [];
    });
  },
};

export class TestFileSystem {
  private readonly fs: ReturnType<typeof sandbox>["session"]["fs"];

  constructor(session: ReturnType<typeof sandbox>["session"]) {
    this.fs = session.fs;
  }

  readFile(...args: Parameters<typeof this.fs.readFile>) {
    return this.fs.readFile(...args);
  }

  writeFile(...args: Parameters<typeof this.fs.writeFile>) {
    return this.fs.writeFile(...args);
  }

  readdir(...args: Parameters<typeof this.fs.readdir>) {
    return this.fs.readdir(...args);
  }

  stat(...args: Parameters<typeof this.fs.stat>) {
    return this.fs.stat(...args);
  }
}

export const vercelSandboxModule = {
  FileSystem: TestFileSystem,
  Sandbox: {
    create: vi.fn(async (options: SandboxCreateOptions) =>
      vercelSandboxFixture.create(options),
    ),
    get: vi.fn(async (options: { name: string }) =>
      vercelSandboxFixture.get(options.name),
    ),
  },
};
