import { getModelType, type AnyModel, type Model, type Api, type RefreshModelsContext } from "@earendil-works/pi-ai";
import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { discover } from "./discovery.ts";
import type { DiscoveryEntry } from "./models-json.ts";

function apiFor(entry: DiscoveryEntry, id: string): Api {
  return entry.modelApis?.[id] ?? entry.api;
}

/**
 * Project a discovered model into the extension model-definition shape Pi composes.
 * Pi's extensionModelFromDefinition requires api and baseUrl on every definition;
 * the models.json layer does not supply them for extension-provided models.
 */
function toModelConfig(entry: DiscoveryEntry, model: Model<Api>): ProviderModelConfig {
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    baseUrl: entry.baseUrl,
    reasoning: model.reasoning,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

function restoreModelConfig(entry: DiscoveryEntry, model: AnyModel): ProviderModelConfig {
  if (getModelType(model) !== "chat") {
    throw new Error("Persisted catalog contains a non-chat model.");
  }
  const chat = model as Model<Api>;
  // Drop stored endpoint fields: current models.json api/baseUrl always wins.
  return {
    id: chat.id,
    name: chat.name,
    api: apiFor(entry, chat.id),
    baseUrl: entry.baseUrl,
    reasoning: chat.reasoning === true,
    input: Array.isArray(chat.input) && chat.input.includes("image") ? ["text", "image"] : ["text"],
    cost: chat.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: chat.contextWindow,
    maxTokens: chat.maxTokens,
  };
}

/**
 * Legacy extension refresh hook composed above the models.json provider layer.
 * Pi resolves the effective /login or models.json credential into context.credential.
 */
export async function refreshModelsFor(
  entry: DiscoveryEntry,
  context: RefreshModelsContext,
  fetcher: typeof fetch = fetch,
): Promise<ProviderModelConfig[]> {
  if (!context.allowNetwork) {
    // Cache-only phase: restore the last persisted catalog without network access.
    return (context.stored?.models ?? []).map((model) => restoreModelConfig(entry, model));
  }
  const models = await discover(entry.id, entry, context, fetcher);
  context.signal.throwIfAborted();
  // Persist the catalog for offline startup; Pi applies generation checks.
  await context.publish({ persist: { models, checkedAt: Date.now() } });
  return models.map((model) => toModelConfig(entry, model));
}
