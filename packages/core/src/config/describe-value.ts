const MAX_SHOWN_VALUE_LENGTH = 60;

/** A TOML value as the operator wrote it, cut short, with its TOML type: `"abc" (a string)`. */
export function describeValue(value: unknown): string {
  const type = Array.isArray(value) ? "an array" : `a ${value === null ? "null" : typeof value}`;
  const text = JSON.stringify(value) ?? String(value);
  const shown =
    text.length > MAX_SHOWN_VALUE_LENGTH ? `${text.slice(0, MAX_SHOWN_VALUE_LENGTH - 1)}…` : text;
  return `${shown} (${type})`;
}
