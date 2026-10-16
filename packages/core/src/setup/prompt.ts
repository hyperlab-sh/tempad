/** Ctrl-C (or Ctrl-D on an empty line) while a prompt was waiting. */
export class InputAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "InputAborted";
  }
}

/** The input stream ended before every prompt was answered. */
export class InputEnded extends Error {
  constructor() {
    super("input ended before every question was answered");
    this.name = "InputEnded";
  }
}

/** A readable stream; a real terminal additionally offers `setRawMode`. */
export type PromptInput = NodeJS.ReadableStream & {
  setRawMode?: (mode: boolean) => unknown;
  isTTY?: boolean;
};

export interface AskOptions {
  /** Read without echoing anything: for secrets. Backspace still edits the buffer. */
  hidden?: boolean;
}

export interface Prompter {
  /** Writes `question`, reads one line, and returns it (untrimmed, without the line break). */
  ask(question: string, options?: AskOptions): Promise<string>;
  /** Yes/no question; Enter answers `defaultYes`. */
  confirm(question: string, defaultYes?: boolean): Promise<boolean>;
  close(): void;
}

const CTRL_C = "\x03";
const CTRL_D = "\x04";
const ESCAPE = "\x1b";

/**
 * Line reader over an injectable stream. It handles every key itself instead of relying
 * on the terminal's line discipline: on a TTY the stream is put in raw mode, where the
 * terminal echoes nothing, so a hidden prompt echoes nothing and a visible one echoes
 * exactly what is typed. Fed from a plain stream (tests, pipes) the same code path runs.
 *
 * Handled keys: Enter (CR, LF or CRLF), Backspace (DEL or BS), Ctrl-C and Ctrl-D (abort),
 * arrow and function-key escape sequences (ignored). Input is read per code point, so a
 * multi-byte character takes one Backspace.
 */
export function createPrompter(input: PromptInput, write: (text: string) => void): Prompter {
  const queue: string[] = [];
  let ended = false;
  let wake: (() => void) | undefined;
  let skipLineFeed = false;

  const notify = (): void => {
    const waiting = wake;
    wake = undefined;
    waiting?.();
  };
  const onData = (chunk: string | Buffer): void => {
    queue.push(...chunk.toString());
    notify();
  };
  const onEnd = (): void => {
    ended = true;
    notify();
  };

  const raw = typeof input.setRawMode === "function" && input.isTTY === true;
  if (raw) input.setRawMode?.(true);
  input.on("data", onData);
  input.on("end", onEnd);
  input.on("close", onEnd);
  input.resume();

  async function nextChar(): Promise<string> {
    while (queue.length === 0) {
      if (ended) throw new InputEnded();
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    return queue.shift() as string;
  }

  /** Drops the rest of an escape sequence (`ESC [ A`, `ESC O P`) that is already buffered. */
  function skipEscapeSequence(): void {
    if (queue[0] !== "[" && queue[0] !== "O") return;
    queue.shift();
    while (queue.length > 0) {
      const code = (queue.shift() as string).charCodeAt(0);
      if (code >= 0x40 && code <= 0x7e) return;
    }
  }

  async function ask(question: string, options: AskOptions = {}): Promise<string> {
    const hidden = options.hidden === true;
    write(question);
    const buffer: string[] = [];
    for (;;) {
      const char = await nextChar();
      if (skipLineFeed) {
        skipLineFeed = false;
        if (char === "\n") continue;
      }
      if (char === CTRL_C || (char === CTRL_D && buffer.length === 0)) {
        write("\n");
        throw new InputAborted();
      }
      if (char === "\r" || char === "\n") {
        skipLineFeed = char === "\r";
        write("\n");
        return buffer.join("");
      }
      if (char === "\x7f" || char === "\b") {
        if (buffer.pop() !== undefined && !hidden) write("\b \b");
        continue;
      }
      if (char === ESCAPE) {
        skipEscapeSequence();
        continue;
      }
      if (char < " ") continue;
      buffer.push(char);
      if (!hidden) write(char);
    }
  }

  async function confirm(question: string, defaultYes = false): Promise<boolean> {
    const answer = (await ask(`${question} ${defaultYes ? "[Y/n]" : "[y/N]"} `)).trim();
    if (answer === "") return defaultYes;
    return /^y(es)?$/i.test(answer);
  }

  function close(): void {
    input.removeListener("data", onData);
    input.removeListener("end", onEnd);
    input.removeListener("close", onEnd);
    if (raw) input.setRawMode?.(false);
    input.pause();
  }

  return { ask, confirm, close };
}
