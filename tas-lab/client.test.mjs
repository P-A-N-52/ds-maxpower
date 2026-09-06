import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from './client.mjs';

test('malformed local TOML never exposes credential-adjacent lines in diagnostics', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tas-config-test-'));
  try {
    const path = join(dir, 'config.toml');
    await writeFile(path, 'api_key = "SYNTHETIC_SECRET"\ninvalid = [\n');
    await assert.rejects(createClient({ configPath: path }), error => {
      assert.equal(error.message, 'Unable to read or parse local Kimi configuration');
      assert.equal(error.stack.includes('SYNTHETIC_SECRET'), false);
      assert.equal(error.cause, undefined);
      return true;
    });
  } finally { await rm(dir, { recursive: true }); }
});

test('streaming completion captures reasoning, output and terminal usage exactly once', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tas-config-test-'));
  try {
    const path = join(dir, 'config.toml');
    await writeFile(path, '[providers.deepseek]\ntype="openai"\nbase_url="https://api.deepseek.com/v1"\napi_key="DUMMY"\n[models."deepseek/deepseek-v4-pro"]\nprovider="deepseek"\nmodel="deepseek-v4-pro"\n');
    const events = [
      { choices: [{ delta: { reasoning_content: 'reason' }, finish_reason: null }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 5 } },
    ];
    const fakeFetch = async (url, init) => {
      assert.equal(url, 'https://api.deepseek.com/v1/chat/completions');
      assert.equal(init.redirect, 'error');
      const payload = JSON.parse(init.body);
      assert.equal(payload.reasoning_effort, 'max');
      assert.equal(payload.thinking.type, 'enabled');
      assert.equal(payload.max_tokens, 2048);
      assert.equal(payload.messages.at(-1).content, 'fixed prompt');
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n');
    };
    const client = await createClient({ configPath: path, fetchImpl: fakeFetch });
    const result = await client.request('fixed prompt', { maxTokens: 2048 });
    assert.equal(result.complete, true);
    assert.equal(result.reasoning, 'reason');
    assert.equal(result.text, 'answer');
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 5 });
    assert.equal(JSON.stringify(client.info).includes('DUMMY'), false);
    const badClient = await createClient({ configPath: path, fetchImpl: async () => { throw new Error('DUMMY failed'); } });
    assert.equal((await badClient.request('x')).error, '[REDACTED] failed');
  } finally { await rm(dir, { recursive: true }); }
});
