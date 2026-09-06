import assert from 'node:assert/strict';
import test from 'node:test';
import { sseData } from './client.mjs';
import { buildPrompt, serializeTraces, usageTotals } from './protocol.mjs';

test('placement changes only trace location; original context and final question stay intact', () => {
  const fixture = { context: 'ORIGINAL\nGRAPH', question: 'QUESTION' };
  const trace = serializeTraces([{ complete: true, reasoning: 'trace α' }, { complete: true, reasoning: 'trace β' }]);
  assert.equal(buildPrompt(fixture, 'first'), 'ORIGINAL\nGRAPH\n\nQUESTION');
  assert.equal(buildPrompt(fixture, 'state', trace), `${trace}\n\nORIGINAL\nGRAPH\n\nQUESTION`);
  assert.equal(buildPrompt(fixture, 'append', trace), `ORIGINAL\nGRAPH\n\n${trace}\n\nQUESTION`);
});

test('incomplete and empty source traces are rejected without selecting by correctness', () => {
  assert.throws(() => serializeTraces([{ complete: false, reasoning: 'partial' }]));
  assert.throws(() => serializeTraces([{ complete: true, reasoning: ' ' }]));
  assert.equal(serializeTraces([{ complete: true, reasoning: '😀a' }], 1).includes('😀\n'), true);
});

test('SSE parser preserves UTF-8 across arbitrary byte boundaries and CRLF frames', async () => {
  const bytes = new TextEncoder().encode('event: message\r\ndata: {"text":"中文"}\r\n\r\ndata: [DONE]\n\n');
  async function* chunks() { for (const byte of bytes) yield Uint8Array.of(byte); }
  const data = [];
  for await (const item of sseData(chunks())) data.push(item);
  assert.deepEqual(data, ['{"text":"中文"}', '[DONE]']);
});

test('failed runs remain in accounting and reasoning tokens are not charged twice', () => {
  const totals = usageTotals([{ complete: true, elapsedMs: 1000, usage: {
    prompt_tokens: 100, prompt_cache_hit_tokens: 40, completion_tokens: 50,
    completion_tokens_details: { reasoning_tokens: 45 },
  } }, { complete: false, elapsedMs: 500, usage: null }]);
  assert.equal(totals.requests, 2);
  assert.equal(totals.missingUsage, 1);
  assert.equal(totals.output, 50);
  assert.equal(totals.cachedInput, 40);
});
