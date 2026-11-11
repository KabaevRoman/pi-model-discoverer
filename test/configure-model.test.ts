import assert from "node:assert/strict";
import { test } from "node:test";
import { applyModelOverride } from "../src/configure-model.ts";

const base = `{
  // user comment
  "providers": {
    "mws": {
      "baseUrl": "https://example.com/v1",
      "api": "openai-completions",
      "apiKey": "$MWS_API_KEY",
      "discoverModels": true
    }
  }
}`;

test("applyModelOverride creates modelOverrides and preserves other provider fields", () => {
  const result = JSON.parse(applyModelOverride(base, "mws", "gpt-x", { reasoning: true, contextWindow: 262144 }));
  const mws = result.providers.mws;
  assert.equal(mws.apiKey, "$MWS_API_KEY");
  assert.equal(mws.discoverModels, true);
  assert.deepEqual(mws.modelOverrides, { "gpt-x": { reasoning: true, contextWindow: 262144 } });
});

test("applyModelOverride merges into existing overrides without dropping siblings", () => {
  const withExisting = applyModelOverride(base, "mws", "a", { reasoning: true });
  const result = JSON.parse(applyModelOverride(withExisting, "mws", "a", { maxTokens: 8192 }));
  assert.deepEqual(result.providers.mws.modelOverrides.a, { reasoning: true, maxTokens: 8192 });
  const second = JSON.parse(applyModelOverride(withExisting, "mws", "b", { contextWindow: 1000 }));
  assert.deepEqual(Object.keys(second.providers.mws.modelOverrides), ["a", "b"]);
});

test("null removes keys and prunes empty override containers", () => {
  const withOverride = applyModelOverride(base, "mws", "a", { reasoning: true, contextWindow: 1000 });
  const removedKey = JSON.parse(applyModelOverride(withOverride, "mws", "a", { reasoning: null }));
  assert.deepEqual(removedKey.providers.mws.modelOverrides.a, { contextWindow: 1000 });
  const removedAll = JSON.parse(applyModelOverride(withOverride, "mws", "a", { reasoning: null, contextWindow: null }));
  assert.equal(removedAll.providers.mws.modelOverrides, undefined);
  assert.equal(removedAll.providers.mws.apiKey, "$MWS_API_KEY");
});

test("undefined patch keys leave existing values untouched", () => {
  const withOverride = applyModelOverride(base, "mws", "a", { reasoning: true });
  const result = JSON.parse(applyModelOverride(withOverride, "mws", "a", { contextWindow: 500 }));
  assert.deepEqual(result.providers.mws.modelOverrides.a, { reasoning: true, contextWindow: 500 });
});

test("applyModelOverride rejects unknown providers, malformed json, and non-object nodes", () => {
  assert.throws(() => applyModelOverride(base, "unknown", "a", {}));
  assert.throws(() => applyModelOverride("{", "mws", "a", {}));
  assert.throws(() => applyModelOverride(`{ "providers": { "mws": "secret-value" } }`, "mws", "a", {}));
  assert.throws(() => applyModelOverride(`{ "providers": { "mws": { "modelOverrides": "nope" } } }`, "mws", "a", {}));
  for (const bad of [() => applyModelOverride(base, "unknown", "a", {}), () => applyModelOverride("{", "mws", "a", {})]) {
    assert.throws(bad, (error: Error) => {
      assert.doesNotMatch(error.message, /secret-value|nope|unknown|\{/);
      return true;
    });
  }
});
