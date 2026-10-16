import { incrementBase32, monotonicFactory } from "ulid";

const monotonicUlid = monotonicFactory();

export function newUlid(): string {
  return monotonicUlid();
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/**
 * `candidate` when it sorts after `maximum`, else the immediate successor of
 * `maximum` (the same 26-character string plus one in Crockford base32).
 *
 * This is what makes an event's `uid` order equal its insertion order on one
 * host: the in-process monotonic factory only orders the ULIDs one process
 * makes, so a second process (a hook, a detached `w5 run`) whose clock reads a
 * millisecond behind could otherwise append a uid below one already stored.
 */
export function ulidAfter(candidate: string, maximum: string | null): string {
  if (maximum === null || candidate > maximum) return candidate;
  return incrementBase32(maximum);
}
