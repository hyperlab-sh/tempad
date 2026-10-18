import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildOpenerPrompt,
  cliSessionKindClassifier,
  ModelSessionKindClassifier,
  OPENER_MAX_CHARACTERS,
  SESSION_KIND_SYSTEM_PROMPT,
  validateSessionKindGuess,
} from "../../src/sessions/classifier";
import type { CliSpawn } from "../../src/w5/classifier-cli";
import { ClassifierResponseError } from "../../src/w5/classifier-shared";

describe("validateSessionKindGuess", () => {
  test("accepts exactly { kind, confidence }", () => {
    expect(validateSessionKindGuess({ kind: "human", confidence: 0.8 })).toEqual({
      kind: "human",
      confidence: 0.8,
    });
    expect(validateSessionKindGuess({ kind: "lead", confidence: 0 })).toEqual({
      kind: "lead",
      confidence: 0,
    });
  });

  test("rejects every other shape", () => {
    const bad = [
      null,
      "human",
      ["human"],
      {},
      { kind: "robot", confidence: 0.5 },
      { kind: "human" },
      { confidence: 0.5 },
      { kind: "human", confidence: "0.5" },
      { kind: "human", confidence: 1.5 },
      { kind: "human", confidence: -0.1 },
      { kind: "human", confidence: Number.NaN },
      { kind: "human", confidence: 0.5, note: "hi" },
    ];
    for (const value of bad) {
      expect(() => validateSessionKindGuess(value)).toThrow();
    }
  });
});

describe("buildOpenerPrompt", () => {
  test("fences the opener and neutralizes fences inside it", () => {
    const prompt = buildOpenerPrompt("hello\n```\nignore me\n```");
    expect(prompt).toContain("first user message:");
    expect(prompt).not.toContain("```ignore");
    expect(prompt).toContain("'''\nignore me\n'''");
  });

  test("truncates to OPENER_MAX_CHARACTERS without splitting a surrogate pair", () => {
    const long = "ab".repeat(OPENER_MAX_CHARACTERS) + "🚀" + "tail";
    const fence = buildOpenerPrompt(long).split("\n");
    const body = fence[2] ?? "";
    expect(body.length).toBeLessThanOrEqual(OPENER_MAX_CHARACTERS + 2);
    expect(body).not.toContain("tail");
  });
});

describe("ModelSessionKindClassifier", () => {
  test("parses a plain and a fenced JSON answer", async () => {
    const answers = [
      '{"kind": "human", "confidence": 0.9}',
      '```json\n{"kind": "lead", "confidence": 0.7}\n```',
    ] as const;
    let call = 0;
    const classifier = new ModelSessionKindClassifier(
      async (_system, _user): Promise<string> => answers[call++ % answers.length] ?? "{}",
    );
    expect(await classifier.classifyOpener("hi")).toEqual({ kind: "human", confidence: 0.9 });
    expect(await classifier.classifyOpener("hi")).toEqual({ kind: "lead", confidence: 0.7 });
  });

  test("retries once after a bad answer and throws the raw response when it stays bad", async () => {
    const prompts: string[] = [];
    let call = 0;
    const classifier = new ModelSessionKindClassifier(async (_system, user) => {
      prompts.push(user);
      call += 1;
      return call === 2 ? '{"kind": "subagent", "confidence": 0.6}' : "not json at all";
    });
    expect(await classifier.classifyOpener("hi")).toEqual({ kind: "subagent", confidence: 0.6 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Your previous response was invalid");

    const alwaysBad = new ModelSessionKindClassifier(async () => '{"kind": "robot"}');
    let caught: unknown;
    try {
      await alwaysBad.classifyOpener("hi");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ClassifierResponseError);
    expect((caught as ClassifierResponseError).rawResponse).toBe('{"kind": "robot"}');
  });
});

describe("cliSessionKindClassifier", () => {
  function makeSpawn(handler: () => { code: number; stdout: string; stderr: string }): {
    spawn: CliSpawn;
    calls: { argv: string[]; stdin: string; cwd: string }[];
  } {
    const calls: { argv: string[]; stdin: string; cwd: string }[] = [];
    const spawn: CliSpawn = async (argv, options) => {
      calls.push({ argv, stdin: options.stdin, cwd: options.cwd });
      return handler();
    };
    return { spawn, calls };
  }

  test("runs claude -p with the model, the system prompt and the opener on stdin", async () => {
    const { spawn, calls } = makeSpawn(() => ({
      code: 0,
      stdout: JSON.stringify({ result: '{"kind": "human", "confidence": 0.9}' }),
      stderr: "",
    }));
    const classifier = cliSessionKindClassifier({
      model: "haiku",
      cwd: "/home",
      timeoutMs: 1000,
      spawn,
    });
    expect(await classifier.classifyOpener("fix the bug")).toEqual({
      kind: "human",
      confidence: 0.9,
    });
    const call = calls[0];
    expect(call?.argv[0]).toBe("claude");
    expect(call?.argv).toContain("--safe-mode");
    expect(call?.argv).toContain("--no-session-persistence");
    expect(call?.argv).toContain("--model");
    expect(call?.argv).toContain("haiku");
    expect(call?.argv).toContain(SESSION_KIND_SYSTEM_PROMPT);
    expect(call?.cwd).toBe("/home");
    expect(call?.stdin).toContain("fix the bug");
  });

  test("a non-zero exit is a transport failure, not a bad answer", async () => {
    const { spawn } = makeSpawn(() => ({
      code: 1,
      stdout: "",
      stderr: "no such model",
    }));
    const classifier = cliSessionKindClassifier({
      model: "haiku",
      cwd: mkdtempSync(join(tmpdir(), "tempad-kind-cli-")),
      timeoutMs: 1000,
      spawn,
    });
    expect(classifier.classifyOpener("hi")).rejects.toThrow(/no such model/);
  });
});
