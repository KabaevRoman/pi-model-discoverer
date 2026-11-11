import assert from "node:assert/strict";
import { test } from "node:test";
import { type Api, type Model, type RefreshModelsContext } from "@earendil-works/pi-ai";
import { parseDiscoveryProviders, stripJsonComments, type DiscoveryEntry } from "../src/models-json.ts";
import { discover, parseModels } from "../src/discovery.ts";
import { refreshModelsFor } from "../src/refresh-hook.ts";

const entry: DiscoveryEntry = { id: "acme", baseUrl: "https://example.com/v1", api: "openai-completions" };
const context = (overrides: Partial<RefreshModelsContext> = {}): RefreshModelsContext => ({
  allowNetwork: true, credential: { type: "api_key", key: "test-secret" },
  signal: new AbortController().signal,
  publish: async ({ update }) => { update?.(); return true; },
  ...overrides,
});

test("models.json parsing honors discoverModels opt-in, comments, and trailing commas", () => {
  assert.deepEqual(parseDiscoveryProviders(`{
    // provider comment
    "providers": {
      "plain": { "baseUrl": "https://a.example/v1", "api": "openai-completions" },
      "acme": {
        "baseUrl": "https://example.com/v1",
        "api": "openai-completions",
        "discoverModels": true,
        "modelApis": { "special": "openai-responses" },
      },
    },
  }`), [{
    id: "acme",
    baseUrl: "https://example.com/v1",
    modelsUrl: undefined,
    api: "openai-completions",
    modelApis: { special: "openai-responses" },
  }]);
  assert.deepEqual(parseDiscoveryProviders("{}"), []);
  assert.deepEqual(parseDiscoveryProviders("{ providers: {} }".replace("providers", `"providers"`)), []);
  assert.throws(() => parseDiscoveryProviders("{"));
  assert.throws(() => parseDiscoveryProviders(`{ "providers": { "acme": { "discoverModels": true } } }`));
  assert.throws(() => parseDiscoveryProviders(`{ "providers": { "acme": {
    "discoverModels": true, "baseUrl": "https://example.com", "api": "openai-completions",
    "modelsUrl": "https://evil.example/models" } } }`));
  assert.throws(() => parseDiscoveryProviders(`{ "providers": { "acme": {
    "discoverModels": true, "baseUrl": "https://example.com", "api": "openai-completions",
    "modelApis": { "x": "bogus" } } } }`));
  // Comments and trailing commas are stripped; comment-like text inside strings is preserved.
  assert.equal(stripJsonComments(`{ "url": "https://x//y", }`), `{ "url": "https://x//y" }`);
});

test("normalization deduplicates, preserves explicit metadata, modelApis, and conservative defaults", () => {
  const models = parseModels({ data: [
    { id: "chat" }, { id: "chat", name: "Chat", context_window: 8192, max_tokens: 1024, reasoning: true, input: ["text", "image"] },
    { id: "other", context_window: -1, max_tokens: "bad" }, { id: "image", type: "image" },
    { id: "special" },
  ] }, "acme", entry.api, entry.baseUrl, { special: "openai-responses" as Api });
  assert.equal(models.length, 3);
  assert.equal(models[0].contextWindow, 8192);
  assert.equal(models[0].maxTokens, 1024);
  assert.equal(models[0].reasoning, true);
  assert.deepEqual(models[0].input, ["text", "image"]);
  assert.equal(models[1].contextWindow, 128000);
  assert.equal(models[1].maxTokens, 16384);
  assert.equal(models[2].api, "openai-responses");
  for (const payload of [{}, { data: [{}] }, { data: [{ id: "\nunsafe" }] }]) {
    assert.throws(() => parseModels(payload, "acme", entry.api, entry.baseUrl));
  }
});

test("discovery sends the resolved credential only to the configured origin with redirects blocked", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://example.com/v1/models");
    assert.equal(new Headers(options?.headers).get("authorization"), "Bearer test-secret");
    assert.equal(options?.redirect, "error");
    assert.ok(options?.signal);
    return Response.json({ data: [{ id: "chat" }] });
  };
  assert.equal((await discover("acme", entry, context(), fetcher)).length, 1);
  await assert.rejects(discover("acme", entry, context({ baseUrl: "https://evil.example/v1" }), fetcher));
  await assert.rejects(discover("acme", entry, context({ credential: undefined }), fetcher));
  await assert.rejects(discover("acme", entry, context({ credential: { type: "oauth", access: "secret", refresh: "secret", expires: Infinity } }), fetcher));
  assert.equal(calls, 1);
});

test("Anthropic catalogs use x-api-key and paginate without following server URLs", async () => {
  let calls = 0;
  const fetcher: typeof fetch = async (url, options) => {
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("x-api-key"), "test-secret");
    assert.equal(headers.get("authorization"), null);
    assert.equal(headers.get("anthropic-version"), "2023-06-01");
    calls++;
    if (calls === 1) return Response.json({ data: [{ id: "a" }], has_more: true, last_id: "a" });
    assert.equal(new URL(String(url)).searchParams.get("after_id"), "a");
    return Response.json({ data: [{ id: "b" }], has_more: false });
  };
  const models = await discover("acme", { ...entry, api: "anthropic-messages" }, context(), fetcher);
  assert.deepEqual(models.map((m) => m.id), ["a", "b"]);
});

test("failures never expose response bodies, URLs, or credential-bearing errors", async () => {
  const failures: (typeof fetch)[] = [
    async () => { throw new Error("test-secret https://secret.example"); },
    async () => new Response("test-secret", { status: 401 }),
    async () => new Response("test-secret"),
    async () => Response.json({ data: [{}] }),
    async () => Response.json({ data: [], has_more: true }),
    async () => new Response(" ".repeat(4 * 1024 * 1024 + 1)),
  ];
  for (const fetcher of failures) {
    await assert.rejects(discover("acme", entry, context(), fetcher), (error: Error) => {
      assert.doesNotMatch(error.message, /test-secret|secret\.example/);
      return true;
    });
  }
});

test("malformed saved keys cannot escape through header validation errors", async () => {
  for (const api of ["openai-completions", "anthropic-messages"] as const) {
    for (const key of ["test-secret\nsecond-line", "test-secretĀ"]) {
      let calls = 0;
      await assert.rejects(discover("acme", { ...entry, api }, context({
        credential: { type: "api_key", key },
      }), async () => { calls++; return Response.json({ data: [] }); }), (error: Error) => {
        assert.doesNotMatch(error.message, /test-secret|second-line/);
        assert.match(error.message, /Model discovery failed/);
        return true;
      });
      assert.equal(calls, 0);
    }
  }
});

test("cancellation does not issue a request", async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(discover("acme", entry, context({ signal: controller.signal }), async () => {
    assert.fail("must not fetch");
  }), /cancelled/);
});

test("refresh hook restores persisted catalogs offline and persists new ones after fetch", async () => {
  const stored: Model<Api>[] = [{
    id: "cached", name: "Cached", provider: "acme", api: entry.api,
    baseUrl: "https://stale.example/v1", reasoning: false, input: ["text"],
    contextWindow: 8192, maxTokens: 1024,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  }];
  let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({ data: [{ id: "new-chat" }] }); };
  const restored = await refreshModelsFor(entry, context({ allowNetwork: false, stored: { models: stored, checkedAt: 1 } }), fetcher);
  assert.equal(calls, 0);
  assert.deepEqual(restored, [{
    id: "cached", name: "Cached", api: "openai-completions", baseUrl: "https://example.com/v1",
    reasoning: false, input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192, maxTokens: 1024,
  }]);
  const persisted: unknown[] = [];
  const refreshed = await refreshModelsFor(entry, context({
    publish: async (publication) => { persisted.push(publication); publication.update?.(); return true; },
  }), fetcher);
  assert.equal(calls, 1);
  assert.equal(persisted.length, 1);
  assert.deepEqual(refreshed.map((m) => m.id), ["new-chat"]);
  // Pi's composer requires api and baseUrl on every extension model definition.
  assert.equal(refreshed[0].api, "openai-completions");
  assert.equal(refreshed[0].baseUrl, "https://example.com/v1");
});
