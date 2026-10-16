import { monotonicFactory } from "ulid";

const monotonicUlid = monotonicFactory();

export function newUlid(): string {
  return monotonicUlid();
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_SPACE = 1n << 128n;

function decodeUlid(value: string): bigint {
  let result = 0n;
  for (const character of value) {
    const digit = CROCKFORD.indexOf(character);
    if (digit < 0) throw new Error(`not a ULID: ${value}`);
    result = result * 32n + BigInt(digit);
  }
  if (result >= ULID_SPACE) throw new Error(`not a ULID: ${value}`);
  return result;
}

function encodeUlid(value: bigint): string {
  let out = "";
  let rest = value;
  for (let index = 0; index < 26; index += 1) {
    out = CROCKFORD[Number(rest & 31n)] + out;
    rest >>= 5n;
  }
  return out;
}

/** A uniform cryptographically random value in 1..2^64. */
function randomIncrement(): bigint {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value + 1n;
}

/**
 * `candidate` when it sorts after `maximum`, else `maximum` plus a random
 * increment in 1..2^64 (added to the 128-bit value, so it carries into the
 * 48-bit time part when the 80-bit random half overflows).
 *
 * Sorting after `maximum` is what makes an event's `uid` order equal its
 * insertion order on one host: the in-process monotonic factory only orders
 * the ULIDs one process makes, so a second process (a hook, a detached
 * `w5 run`) whose clock reads a millisecond behind could otherwise append a
 * uid below one already stored, and a pulled uid from a host whose clock runs
 * ahead would let a local event sort before an already-applied one.
 *
 * The increment is random rather than +1 because two hosts can hold the same
 * maximum (one pulled from a third host whose clock runs ahead) and both
 * append while behind it: a deterministic successor gives both events the
 * same uid, and `ON CONFLICT (uid) DO NOTHING` then drops one of them
 * everywhere. With 64 random bits the two uids collide with negligible
 * probability. Overflowing the 128-bit ULID space is an explicit error.
 *
 * `increment` is injectable for tests only.
 */
export function ulidAfter(
  candidate: string,
  maximum: string | null,
  increment: () => bigint = randomIncrement,
): string {
  if (maximum === null || candidate > maximum) return candidate;
  const next = decodeUlid(maximum) + increment();
  if (next >= ULID_SPACE) {
    throw new Error(`event uid space exhausted: no ULID sorts after ${maximum}`);
  }
  return encodeUlid(next);
}
