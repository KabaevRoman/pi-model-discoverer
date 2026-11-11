import type { ModelRegistry } from "@earendil-works/pi-coding-agent";

export type Registry = Pick<ModelRegistry,
  "getAll" | "getRegisteredProviderIds" | "getProvider" | "getProviderAuthStatus" | "refresh" | "getError">;

export async function refreshCatalogs(
  registry: Registry,
  knownIds: readonly string[],
  requested: string | undefined,
  signal: AbortSignal,
  force = true,
): Promise<string[]> {
  const ids = requested ? [requested] : [...new Set([
    ...knownIds, ...registry.getRegisteredProviderIds(), ...registry.getAll().map((model) => model.provider),
  ])].sort();
  const lines: string[] = [];
  const selected: string[] = [];
  for (const id of ids) {
    const provider = registry.getProvider(id);
    if (!provider) {
      if (requested) lines.push("Unknown provider. Use its exact /login provider ID.");
      continue;
    }
    if (!registry.getProviderAuthStatus(id).configured) {
      if (requested) lines.push(`${id}: no configured authentication; use /login.`);
      continue;
    }
    if (!provider.refreshModels) {
      lines.push(`${id}: no native discovery; keeping existing catalog.`);
      continue;
    }
    selected.push(id);
  }
  if (selected.length) {
    const result = await registry.refresh({ providers: selected, allowNetwork: true, force, signal });
    for (const id of selected) {
      if (result.errors.has(id)) lines.push(`${id}: refresh failed; keeping previous catalog. Check authentication and connectivity.`);
      else if (result.aborted) lines.push(`${id}: refresh interrupted; catalog may be unchanged.`);
      // Pi may silently supersede a provider refresh; absence of errors is not
      // evidence that this invocation published a new catalog.
      else lines.push(`${id}: refresh finished; current catalog: ${registry.getProvider(id)?.getModels().length ?? 0} chat models.`);
    }
    if (registry.getError()) lines.push("Pi reported a models.json error; check that configuration.");
  }
  return lines.length ? lines : ["No authenticated providers to discover. Run /login first."];
}
