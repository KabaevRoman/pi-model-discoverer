import assert from "node:assert/strict";
import { test } from "node:test";
import type { ModelsRefreshOptions, Provider } from "@earendil-works/pi-ai";
import { refreshCatalogs, type Registry } from "../src/refresh.ts";

function fixture() {
  const providers = new Map<string, Provider>([
    ["native", { id: "native", refreshModels: async () => {}, getModels: () => [] } as unknown as Provider],
    ["static", { id: "static", getModels: () => [] } as unknown as Provider],
    ["unconfigured", { id: "unconfigured", refreshModels: async () => {}, getModels: () => [] } as unknown as Provider],
  ]);
  const calls: ModelsRefreshOptions[] = [];
  const registry: Registry = {
    getAll: () => [], getRegisteredProviderIds: () => [],
    getProvider: (id) => providers.get(id),
    getProviderAuthStatus: (id) => ({ configured: id !== "unconfigured" }),
    getError: () => undefined,
    async refresh(options) { calls.push(options!); return { aborted: false, errors: new Map() }; },
  };
  return { registry, calls, ids: [...providers.keys()] };
}

test("native discovery delegates to Pi, selecting only authenticated dynamic providers", async () => {
  const { registry, calls, ids } = fixture();
  const signal = new AbortController().signal;
  const result = await refreshCatalogs(registry, ids, undefined, signal);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { providers: ["native"], allowNetwork: true, force: true, signal });
  assert.match(result.join("\n"), /static: no native discovery/);
  assert.match(result.join("\n"), /native: refresh finished; current catalog: 0 chat models/);
  assert.doesNotMatch(result.join("\n"), /unconfigured/);
});

test("session-start refresh does not force a network fetch", async () => {
  const { registry, calls, ids } = fixture();
  await refreshCatalogs(registry, ids, undefined, new AbortController().signal, false);
  assert.equal(calls[0]?.force, false);
});

test("explicit unknown and unauthenticated providers do not cause a refresh", async () => {
  const { registry, calls, ids } = fixture();
  const signal = new AbortController().signal;
  assert.match((await refreshCatalogs(registry, ids, "unknown", signal))[0], /Unknown provider/);
  assert.match((await refreshCatalogs(registry, ids, "unconfigured", signal))[0], /use \/login/);
  assert.equal(calls.length, 0);
});

test("refresh reports per-provider failures without leaking native auth errors", async () => {
  const { registry, ids } = fixture();
  registry.refresh = async () => ({ aborted: false, errors: new Map([["native", new Error("secret-access-token")]]) });
  const result = await refreshCatalogs(registry, ids, undefined, new AbortController().signal);
  assert.match(result.join("\n"), /refresh failed/);
  assert.doesNotMatch(result.join("\n"), /secret-access-token|catalog refreshed/);
});

test("cancelled refresh is not reported as successful", async () => {
  const { registry, ids } = fixture();
  registry.refresh = async () => ({ aborted: true, errors: new Map() });
  const result = await refreshCatalogs(registry, ids, "native", new AbortController().signal);
  assert.match(result[0], /interrupted/);
  assert.doesNotMatch(result[0], /refresh finished/);
});

test("a silently superseded refresh does not claim that new models were published", async () => {
  const { registry, ids } = fixture();
  // Pi 1.5.2 returns this for a provider operation superseded by another refresh,
  // even when the old operation published nothing.
  registry.refresh = async () => ({ aborted: false, errors: new Map() });
  const result = await refreshCatalogs(registry, ids, "native", new AbortController().signal);
  assert.match(result[0], /current catalog: 0 chat models/);
  assert.doesNotMatch(result[0], /catalog refreshed|discovered|published/);
});
