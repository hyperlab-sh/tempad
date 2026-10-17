import {
  type ClassifierResult,
  type ClassifierWindow,
  cutAtCodePoint,
  validateResult,
} from "./classifier";

/**
 * Written between a failed job's message and the start of the response that
 * failed it, so a reader (and `tempad scry`, which groups failures by message
 * alone) can tell where one ends and the other begins.
 */
export const RESPONSE_EXCERPT_MARKER = "\n--- response (start) ---\n";

/** How much of a rejected response a failed job keeps. */
export const RESPONSE_EXCERPT_LENGTH = 500;

/**
 * The classifier's answer could not be used after the retry. Carries what the
 * model actually sent, which the message alone never says: the 316 jobs that
 * failed on one missing alias could only be diagnosed by rebuilding the window
 * from events, because nothing recorded the response.
 */
export class ClassifierResponseError extends Error {
  readonly rawResponse: string;

  constructor(message: string, rawResponse: string) {
    super(message);
    this.name = "ClassifierResponseError";
    this.rawResponse = rawResponse;
  }
}

/**
 * The text a failed job stores in `w5_jobs.error`: the message, then, when the
 * failure was a rejected response, a bounded excerpt of it.
 */
export function describeJobFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof ClassifierResponseError) || error.rawResponse === "") return message;
  return `${message}${RESPONSE_EXCERPT_MARKER}${cutAtCodePoint(error.rawResponse, RESPONSE_EXCERPT_LENGTH)}`;
}

/** The message half of a stored failure, without the response excerpt. */
export function failureMessage(stored: string): string {
  const at = stored.indexOf(RESPONSE_EXCERPT_MARKER);
  return at === -1 ? stored : stored.slice(0, at);
}

export function extractJsonText(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return (fenced?.[1] ?? text).trim();
}

export async function classifyWithRetry(
  window: ClassifierWindow,
  userPrompt: string,
  request: (prompt: string) => Promise<string>,
): Promise<ClassifierResult> {
  const first = await request(userPrompt);
  try {
    return validateResult(JSON.parse(extractJsonText(first)), window);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const retryPrompt = `${userPrompt}\n\nYour previous response was invalid: ${message}\nRespond with valid JSON only.`;
    const second = await request(retryPrompt);
    try {
      return validateResult(JSON.parse(extractJsonText(second)), window);
    } catch (retryError) {
      throw new ClassifierResponseError(
        retryError instanceof Error ? retryError.message : String(retryError),
        second,
      );
    }
  }
}
