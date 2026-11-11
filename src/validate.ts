export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse and validate an endpoint URL: HTTPS, or HTTP on loopback only; no credentials/query/fragment. Throws a sanitized error. */
export function endpointUrl(value: unknown): URL {
  if (typeof value !== "string") fail();
  let url: URL;
  try {
    url = new URL(value as string);
  } catch {
    fail();
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && local)) ||
    url.username || url.password || url.search || url.hash
  ) fail();
  return url;
}

function fail(): never {
  throw new Error("Invalid discovery endpoint URL; see the README configuration reference.");
}
