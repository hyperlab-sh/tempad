import { childEnvironment } from "../config/child-env";
import type { Classifier, ClassifierResult, ClassifierWindow } from "./classifier";
import { classifyWithRetry } from "./classifier-shared";
import { buildSystemPrompt, buildUserPrompt } from "./prompt";

export interface CliSpawnResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type CliSpawn = (
  argv: string[],
  options: { cwd: string; stdin: string; timeoutMs: number },
) => Promise<CliSpawnResult>;

const KILL_GRACE_MS = 5_000;

export const defaultSpawn: CliSpawn = async (argv, options) => {
  const child = Bun.spawn(argv, {
    cwd: options.cwd,
    // The model needs no tempad credential, least of all the sync server's.
    env: childEnvironment(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  child.stdin.write(options.stdin);
  child.stdin.end();

  const collected = Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr }) as CliSpawnResult);

  const timedOut = new Promise<never>((_resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => {
        child.kill("SIGKILL");
      }, KILL_GRACE_MS);
      // Do not let the kill timer keep the process alive if it fires after exit.
      collected.finally(() => clearTimeout(killTimer));
      reject(new Error(`claude cli timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    collected.finally(() => clearTimeout(timeout));
  });

  return Promise.race([collected, timedOut]);
};

export interface ClaudeCliClassifierOptions {
  model: string;
  command?: string;
  cwd: string;
  spawn?: CliSpawn;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 120_000;

export class ClaudeCliClassifier implements Classifier {
  private readonly model: string;
  private readonly command: string;
  private readonly cwd: string;
  private readonly spawnImpl: CliSpawn;
  private readonly timeoutMs: number;

  constructor(options: ClaudeCliClassifierOptions) {
    this.model = options.model;
    this.command = options.command ?? "claude";
    this.cwd = options.cwd;
    this.spawnImpl = options.spawn ?? defaultSpawn;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async classify(window: ClassifierWindow): Promise<ClassifierResult> {
    // The window's mode decides which schema the model is asked to fill in.
    const systemPrompt = buildSystemPrompt(window.mode);
    const userPrompt = buildUserPrompt(window);
    return classifyWithRetry(window, userPrompt, (prompt) => this.request(systemPrompt, prompt));
  }

  private request(systemPrompt: string, userPrompt: string): Promise<string> {
    return requestClaudeCli(
      {
        command: this.command,
        model: this.model,
        cwd: this.cwd,
        spawn: this.spawnImpl,
        timeoutMs: this.timeoutMs,
      },
      systemPrompt,
      userPrompt,
    );
  }
}

export interface ClaudeCliRequestOptions {
  command: string;
  model: string;
  cwd: string;
  spawn: CliSpawn;
  timeoutMs: number;
}

/**
 * One `claude -p` call in print mode with no tools and no session file, the
 * prompt on stdin, returning the model's text from the JSON envelope. The w5
 * classifier and the session kind classifier (`src/sessions/classifier.ts`) both
 * go through it.
 */
export async function requestClaudeCli(
  options: ClaudeCliRequestOptions,
  systemPrompt: string,
  userPrompt: string,
): Promise<string> {
  const argv = [
    options.command,
    "-p",
    "--safe-mode",
    "--no-session-persistence",
    "--output-format",
    "json",
    "--model",
    options.model,
    "--tools",
    "",
    "--system-prompt",
    systemPrompt,
  ];

  let result: CliSpawnResult;
  try {
    result = await options.spawn(argv, {
      cwd: options.cwd,
      stdin: userPrompt,
      timeoutMs: options.timeoutMs,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`claude cli spawn failed: ${message}`);
  }

  if (result.code !== 0) {
    throw new Error(`claude cli exited with code ${result.code}: ${result.stderr.slice(0, 200)}`);
  }

  let envelope: { result?: unknown };
  try {
    envelope = JSON.parse(result.stdout) as { result?: unknown };
  } catch {
    throw new Error(`claude cli output was not valid JSON: ${result.stdout.slice(0, 200)}`);
  }

  if (typeof envelope.result !== "string") {
    throw new Error(`claude cli envelope had no result field: ${result.stdout.slice(0, 200)}`);
  }

  return envelope.result;
}
