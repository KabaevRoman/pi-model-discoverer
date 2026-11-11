import { endpointUrl, record } from "./validate.ts";

export const APIS = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
export type DiscoveryApi = (typeof APIS)[number];

export interface DiscoveryEntry {
  id: string;
  baseUrl: string;
  modelsUrl?: string;
  api: DiscoveryApi;
  modelApis?: Record<string, DiscoveryApi>;
}

function fail(): never {
  // Never echo config values: a mistaken configuration may contain a secret.
  throw new Error("Invalid discoverModels provider in models.json; see the README configuration reference.");
}

/** Strip `//` comments and trailing commas, leaving string literals untouched (matches Pi's models.json parsing). */
export function stripJsonComments(input: string): string {
  return input
    .replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (m) => (m[0] === '"' ? m : ""))
    .replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (m, tail) => tail ?? (m[0] === '"' ? m : ""));
}

/** Extract providers opted into discovery with `discoverModels: true` from raw models.json text. */
export function parseDiscoveryProviders(content: string): DiscoveryEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(content.replace(/^﻿/, "")));
  } catch {
    return fail();
  }
  if (!record(parsed) || parsed.providers === undefined) return [];
  if (!record(parsed.providers)) fail();
  const entries: DiscoveryEntry[] = [];
  for (const [id, provider] of Object.entries(parsed.providers)) {
    if (!record(provider)) fail();
    if (provider.discoverModels !== true) continue;
    if (!APIS.includes(provider.api as DiscoveryApi)) fail();
    const base = endpointUrl(provider.baseUrl);
    const modelsUrl = provider.modelsUrl === undefined ? undefined : endpointUrl(provider.modelsUrl);
    if (modelsUrl && modelsUrl.origin !== base.origin) fail();
    const modelApis: Record<string, DiscoveryApi> = {};
    if (provider.modelApis !== undefined) {
      if (!record(provider.modelApis)) fail();
      for (const [modelId, api] of Object.entries(provider.modelApis)) {
        if (!APIS.includes(api as DiscoveryApi)) fail();
        modelApis[modelId] = api as DiscoveryApi;
      }
    }
    entries.push({
      id,
      baseUrl: base.href.replace(/\/$/, ""),
      modelsUrl: modelsUrl?.href,
      api: provider.api as DiscoveryApi,
      modelApis: Object.keys(modelApis).length ? modelApis : undefined,
    });
  }
  return entries;
}
