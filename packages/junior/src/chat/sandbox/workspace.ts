export interface SandboxCommandResult {
  exitCode: number;
  stderr(): Promise<string>;
  stdout(): Promise<string>;
}

export interface SandboxWorkspace {
  readonly sandboxId?: string;
  readFileToBuffer(input: { path: string }): Promise<Buffer | null | undefined>;
  runCommand(input: {
    args?: string[];
    cmd: string;
    cwd?: string;
  }): Promise<SandboxCommandResult>;
}
