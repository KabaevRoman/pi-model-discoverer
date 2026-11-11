import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { configureModel } from "./configure-model.ts";
import { parseDiscoveryProviders, type DiscoveryEntry } from "./models-json.ts";
import { refreshModelsFor } from "./refresh-hook.ts";
import { refreshCatalogs } from "./refresh.ts";

const REFRESH_TIMEOUT_MS = 30000;

export default async function modelDiscoverer(pi: ExtensionAPI): Promise<void> {
  // Providers opt into discovery with "discoverModels": true in models.json.
  // Pi ignores that unknown key; this extension reads the file itself.
  let entries: DiscoveryEntry[];
  const modelsJsonPath = join(getAgentDir(), "models.json");
  try {
    entries = parseDiscoveryProviders(await readFile(modelsJsonPath, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new Error("Cannot read models.json for model discovery; check its syntax.");
    }
    entries = [];
  }
  const discoveredIds: string[] = [];
  for (const entry of entries) {
    // Legacy registration composes above the models.json provider layer: Pi keeps
    // the provider's baseUrl/apiKey/auth and streams through the configured API.
    pi.registerProvider(entry.id, {
      refreshModels: (context) => refreshModelsFor(entry, context),
    });
    discoveredIds.push(entry.id);
  }

  const lifetime = new AbortController();
  let running = false;

  async function refresh(ctx: ExtensionContext, requested?: string, force = false): Promise<void> {
    if (running) {
      if (ctx.hasUI) ctx.ui.notify("Model discovery is already running.", "info");
      return;
    }
    running = true;
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]);
      // No explicit id list: refreshes every authenticated provider with a refresh hook,
      // including native Pi providers and our discoverModels providers.
      const lines = await refreshCatalogs(ctx.modelRegistry, discoveredIds, requested, signal, force);
      if (ctx.hasUI && !lifetime.signal.aborted) ctx.ui.notify(lines.join("\n"), "info");
    } catch {
      if (ctx.hasUI && !lifetime.signal.aborted) {
        ctx.ui.notify("Model discovery failed. Check authentication, configuration, and connectivity.", "warning");
      }
    } finally {
      running = false;
    }
  }

  pi.registerCommand("discover-models", {
    description: "Refresh model catalogs using existing /login credentials (optional provider ID)",
    async handler(args, ctx) {
      const id = args.trim();
      if (id && !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(id)) {
        ctx.ui.notify("Usage: /discover-models [provider-id]", "warning");
        return;
      }
      await ctx.waitForIdle();
      await refresh(ctx, id || undefined, true);
    },
  });
  pi.registerCommand("configure-model", {
    description: "Edit capability overrides (reasoning, contextWindow, maxTokens) for a discovered model",
    async handler(args, ctx) {
      await ctx.waitForIdle();
      await configureModel(entries, args, ctx, modelsJsonPath);
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    // Pi already refreshed during startup; only force-fetch on explicit command.
    await refresh(ctx, undefined, false);
  });
  pi.on("session_shutdown", () => { lifetime.abort(); });
}
