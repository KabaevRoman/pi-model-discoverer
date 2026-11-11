import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi's actual extension loader registers the command and discovery hook from models.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-discoverer-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    await writeFile(join(directory, "models.json"), JSON.stringify({
      providers: { acme: { baseUrl: "https://example.com/v1", api: "openai-completions", discoverModels: true } },
    }));
    const result = await discoverAndLoadExtensions([resolve("src/index.ts")], directory, directory);
    assert.deepEqual(result.errors, []);
    assert.equal(result.extensions.length, 1);
    assert.ok(result.extensions[0].commands.has("discover-models"));
    assert.ok(result.extensions[0].handlers.has("session_start"));
    assert.ok(result.extensions[0].handlers.has("session_shutdown"));
    assert.equal(result.runtime.pendingProviderRegistrations.length, 1);
    assert.equal(result.runtime.pendingProviderRegistrations[0].name, "acme");
    assert.equal(typeof result.runtime.pendingProviderRegistrations[0].config.refreshModels, "function");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});

test("loader tolerates a missing models.json", async () => {
  const directory = await mkdtemp(join(tmpdir(), "model-discoverer-test-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = directory;
  try {
    const result = await discoverAndLoadExtensions([resolve("src/index.ts")], directory, directory);
    assert.deepEqual(result.errors, []);
    assert.equal(result.runtime.pendingProviderRegistrations.length, 0);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
  }
});
