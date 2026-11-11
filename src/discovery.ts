import type { Api, Model, RefreshModelsContext } from "@earendil-works/pi-ai";
import { endpointUrl, record } from "./validate.ts";
import type { DiscoveryEntry } from "./models-json.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const MAX_MODELS = 10000;
const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 16384;
const positive = (value: unknown, fallback: number): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;

export function parseModels(payload: unknown, id: string, api: Api, baseUrl: string, modelApis?: Record<string, Api>): Model<Api>[] {
  if (!record(payload) || !Array.isArray(payload.data) || payload.data.length > MAX_MODELS) {
    throw new Error("Invalid model catalog.");
  }
  const models = new Map<string, Model<Api>>();
  for (const item of payload.data) {
    if (!record(item) || typeof item.id !== "string" || !item.id.trim() ||
        item.id.length > 256 || /[\u0000-\u001f\u007f]/.test(item.id)) {
      throw new Error("Invalid model catalog entry.");
    }
    // Explicitly non-chat entries must not become selectable chat models.
    if (item.type !== undefined && item.type !== "model" && item.type !== "chat") continue;
    const contextWindow = positive(item.context_window ?? item.context_length, DEFAULT_CONTEXT_WINDOW);
    const maxTokens = Math.min(contextWindow, positive(item.max_tokens ?? item.max_output_tokens, DEFAULT_MAX_TOKENS));
    const name = typeof item.name === "string" ? item.name : item.display_name;
    models.set(item.id, {
      id: item.id,
      name: typeof name === "string" && name.length <= 256 && !/[\u0000-\u001f\u007f]/.test(name) ? name : item.id,
      provider: id,
      api: modelApis?.[item.id] ?? api,
      baseUrl,
      reasoning: item.reasoning === true,
      input: Array.isArray(item.input) && item.input.includes("image") ? ["text", "image"] : ["text"],
      contextWindow,
      maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    });
  }
  return [...models.values()];
}

async function readJson(response: Response): Promise<unknown> {
  if (!response.body) throw new Error("Empty model catalog response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw new Error("Model catalog response is too large.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function discover(
  id: string,
  entry: DiscoveryEntry,
  context: RefreshModelsContext,
  fetcher: typeof fetch = fetch,
): Promise<Model<Api>[]> {
  // OAuth is provider-specific. Never treat a subscription token as a generic key.
  if (context.credential?.type !== "api_key" || !context.credential.key) {
    throw new Error("Custom discovery requires an API key credential.");
  }
  const base = endpointUrl(context.baseUrl ?? entry.baseUrl);
  // A later configuration change must not redirect a credential to another origin.
  if (base.origin !== endpointUrl(entry.baseUrl).origin) throw new Error("Discovery endpoint origin changed.");
  const url = endpointUrl(entry.modelsUrl ?? `${base.href.replace(/\/$/, "")}/models`);
  if (url.origin !== base.origin) throw new Error("Discovery endpoint origin changed.");
  const signal = context.signal;
  const models = new Map<string, Model<Api>>();
  const cursors = new Set<string>();
  try {
    // Header validation errors can include the invalid value, so sanitize them too.
    const headers = new Headers({ accept: "application/json" });
    if (entry.api === "anthropic-messages") {
      headers.set("x-api-key", context.credential.key);
      headers.set("anthropic-version", "2023-06-01");
    } else {
      headers.set("authorization", `Bearer ${context.credential.key}`);
    }
    for (let page = 0; page < 20; page++) {
      signal.throwIfAborted();
      const response = await fetcher(url, { headers, signal, redirect: "error" });
      if (!response.ok) {
        await response.body?.cancel();
        throw new DiscoveryError(`HTTP ${response.status}`);
      }
      const payload = await readJson(response);
      for (const model of parseModels(payload, id, entry.api, base.href.replace(/\/$/, ""), entry.modelApis)) {
        models.set(model.id, model);
      }
      if (models.size > MAX_MODELS) throw new DiscoveryError("too many models");
      if (!record(payload) || payload.has_more !== true) return [...models.values()];
      if (entry.api !== "anthropic-messages" || typeof payload.last_id !== "string" ||
          !payload.last_id || cursors.has(payload.last_id)) throw new DiscoveryError("unsupported pagination");
      cursors.add(payload.last_id);
      url.searchParams.set("after_id", payload.last_id);
    }
    throw new DiscoveryError("too many pages");
  } catch (error) {
    // Fetch errors and provider bodies may contain credentials or sensitive URLs.
    if (signal.aborted) throw new Error("Model discovery cancelled or timed out.");
    if (error instanceof DiscoveryError) {
      throw new Error(`Model discovery failed: ${error.reason}.`);
    }
    // Node fetch failures carry a safe machine-readable code (ENOTFOUND, ECONNREFUSED, ...).
    const code = (error as { cause?: { code?: unknown } })?.cause?.code;
    const suffix = typeof code === "string" && /^[A-Z0-9_]+$/.test(code) ? `: network ${code}` : "";
    throw new Error(`Model discovery failed${suffix}.`);
  }
}

class DiscoveryError extends Error {
  constructor(readonly reason: string) { super(reason); }
}
