#!/usr/bin/env node
import { spawn } from 'node:child_process';

const inputArgs = process.argv.slice(2);
let caseFilter;
const passthroughArgs = [];

for (let index = 0; index < inputArgs.length; index += 1) {
  const arg = inputArgs[index];
  if (arg.startsWith("--case=")) {
    caseFilter = arg.slice("--case=".length);
    continue;
  }
  if (arg.startsWith("--match=")) {
    caseFilter = arg.slice("--match=".length);
    continue;
  }
  if ((arg === '--case' || arg === '--match') && inputArgs[index + 1]) {
    caseFilter = inputArgs[index + 1];
    index += 1;
    continue;
  }

  if (!caseFilter && !arg.startsWith('-')) {
    caseFilter = arg;
    continue;
  }

  passthroughArgs.push(arg);
}

const vitestArgs = [
  'run',
  '-c',
  'vitest.evals.config.ts',
  'evals/llm-judge.eval.ts',
  '--reporter=verbose',
  ...passthroughArgs
];

const child = spawn('pnpm', ['exec', 'vitest', ...vitestArgs], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ...(caseFilter ? { EVAL_CASE_FILTER: caseFilter } : {})
  }
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
