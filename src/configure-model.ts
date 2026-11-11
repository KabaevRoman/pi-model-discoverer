import { copyFile, readFile, writeFile } from "node:fs/promises";
import type { ExtensionCommandContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { record } from "./validate.ts";
import { stripJsonComments, type DiscoveryEntry } from "./models-json.ts";

/** `null` removes the key from the override; `undefined` leaves it untouched. */
export interface OverridePatch {
  reasoning?: boolean | null;
  contextWindow?: number | null;
  maxTokens?: number | null;
}

const PATCH_KEYS = ["reasoning", "contextWindow", "maxTokens"] as const;

function fail(): never {
  // Never echo config values: a mistaken configuration may contain a secret.
  throw new Error("Cannot update models.json; check its syntax and the provider id.");
}

/** Return parent[key] as a mutable record, creating it if absent; fail on non-object values. */
function childRecord(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = parent[key];
  if (value !== undefined && !record(value)) fail();
  const child = record(value) ? value : {};
  parent[key] = child;
  return child;
}

/** Merge a modelOverride patch into raw models.json text and return the updated text. */
export function applyModelOverride(content: string, providerId: string, modelId: string, patch: OverridePatch): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonComments(content.replace(/^﻿/, "")));
  } catch {
    fail();
  }
  if (!record(parsed) || !record(parsed.providers) || parsed.providers[providerId] === undefined) fail();
  const provider = childRecord(parsed.providers, providerId);
  const overrides = childRecord(provider, "modelOverrides");
  const model = childRecord(overrides, modelId);
  for (const key of PATCH_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) delete model[key];
    else model[key] = value;
  }
  if (Object.keys(model).length === 0) delete overrides[modelId];
  if (Object.keys(overrides).length === 0) delete provider.modelOverrides;
  return JSON.stringify(parsed, null, 2) + "\n";
}

function parseLimit(raw: string | undefined): number | null | undefined {
  if (raw === undefined) return undefined; // cancelled
  const trimmed = raw.trim();
  if (trimmed === "" || /^(-|remove|inherit|default)$/i.test(trimmed)) return null;
  if (!/^[1-9][0-9]{0,8}$/.test(trimmed)) return undefined;
  return Number(trimmed);
}

/** Interactive /configure-model flow: pick provider and model, edit capability overrides. */
export async function configureModel(
  entries: DiscoveryEntry[],
  args: string,
  ctx: ExtensionCommandContext,
  modelsJsonPath: string,
): Promise<void> {
  if (!ctx.hasUI) {
    throw new Error("/configure-model needs interactive UI; edit modelOverrides in models.json directly instead.");
  }
  if (entries.length === 0) {
    ctx.ui.notify('No discoverModels providers in models.json.', "warning");
    return;
  }
  const requested = args.trim();
  let entry = requested ? entries.find((candidate) => candidate.id === requested) : undefined;
  if (requested && !entry) {
    ctx.ui.notify(`Unknown discoverModels provider "${requested}". Configured: ${entries.map((e) => e.id).join(", ")}`, "warning");
    return;
  }
  if (!entry) {
    const picked = await ctx.ui.select("Configure which provider?", entries.map((e) => e.id));
    if (!picked) return;
    entry = entries.find((candidate) => candidate.id === picked)!;
  }
  const models = listModels(ctx.modelRegistry, entry.id);
  if (models.length === 0) {
    ctx.ui.notify(`Provider ${entry.id} has no models. Run /discover-models ${entry.id} first.`, "warning");
    return;
  }
  const modelLabel = await ctx.ui.select(`Configure which ${entry.id} model?`, models.map(
    (m) => `${m.id} — context ${m.contextWindow}, max ${m.maxTokens}${m.reasoning ? ", reasoning" : ""}`,
  ));
  if (!modelLabel) return;
  const modelId = modelLabel.split(" — ")[0];

  const patch: OverridePatch = {};
  let dirty = false;
  for (;;) {
    const field = await ctx.ui.select(`Edit ${modelId}`, [
      `reasoning: ${display(patch.reasoning)}`,
      `contextWindow: ${display(patch.contextWindow)}`,
      `maxTokens: ${display(patch.maxTokens)}`,
      dirty ? "save and exit" : "exit without changes",
    ]);
    if (!field || field.startsWith("exit")) return;
    if (field.startsWith("save")) break;
    if (field.startsWith("reasoning")) {
      const value = await ctx.ui.select("reasoning", ["true", "false", "remove override"]);
      if (value === undefined) continue;
      patch.reasoning = value === "remove override" ? null : value === "true";
    } else {
      const key = field.startsWith("contextWindow") ? "contextWindow" : "maxTokens";
      const raw = await ctx.ui.input(`New ${key} (tokens, or "remove" to clear the override)`);
      const value = parseLimit(raw);
      if (value === undefined) {
        if (raw !== undefined) ctx.ui.notify("Enter a positive whole number of tokens, or \"remove\".", "warning");
        continue;
      }
      patch[key] = value;
    }
    dirty = true;
  }
  const updated = applyModelOverride(await readFile(modelsJsonPath, "utf8"), entry.id, modelId, patch);
  // One-time backup: rewriting drops comments/formatting from the original file.
  await copyFile(modelsJsonPath, modelsJsonPath + ".bak").catch(() => {});
  await writeFile(modelsJsonPath, updated, "utf8");
  ctx.ui.notify(`Saved overrides for ${entry.id}/${modelId} to models.json. Run /reload to apply.`, "info");
}

function display(value: boolean | number | null | undefined): string {
  if (value === undefined) return "unchanged";
  if (value === null) return "override removed";
  return String(value);
}

function listModels(registry: ModelRegistry, providerId: string) {
  return registry.getProvider(providerId)?.getModels() ?? [];
}
