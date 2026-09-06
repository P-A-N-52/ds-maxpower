import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { buildPrompt, hash, serializeTraces } from './protocol.mjs';
import { scoreAnswer } from './fixtures.mjs';

const directory = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node verify-run.mjs RUN_DIRECTORY');
const json = async name => JSON.parse(await readFile(join(directory, name), 'utf8'));
const [manifest, fixtures, names] = await Promise.all([json('manifest.json'), json('fixtures.json'), readdir(directory)]);
const files = new Set(names);
let verifiedCalls = 0;
let verifiedPairs = 0;
for (const fixture of fixtures) {
  const sources = [];
  const trace = files.has(`${fixture.id}.trace.txt`)
    ? await readFile(join(directory, `${fixture.id}.trace.txt`), 'utf8') : '';
  for (const condition of ['first-1', 'first-2', 'append', 'state']) {
    const label = `${fixture.id}-${condition}`;
    if (!files.has(`${label}.json`)) continue;
    const record = await json(`${label}.json`);
    const prompt = await readFile(join(directory, `${label}.prompt.txt`), 'utf8');
    const placement = condition.startsWith('first') ? 'first' : condition;
    assert.equal(prompt, buildPrompt(fixture, placement, trace), `${label}: unexpected prompt bytes`);
    assert.equal(record.promptHash, hash(prompt), `${label}: prompt hash mismatch`);
    const score = scoreAnswer(record.text, fixture.expected);
    assert.equal(record.score.em, record.complete ? score.em : 0, `${label}: EM mismatch`);
    assert.equal(record.score.f1, record.complete ? score.f1 : 0, `${label}: F1 mismatch`);
    assert.equal(record.maxTokens, manifest.maxOutputTokens, `${label}: output cap drift`);
    if (placement === 'first') sources.push(record);
    verifiedCalls++;
  }
  if (trace) {
    assert.equal(sources.length, manifest.sourceRuns, `${fixture.id}: missing source records`);
    assert.equal(trace, serializeTraces(sources, manifest.maxTraceCharacters), `${fixture.id}: trace differs from sources`);
    if (files.has(`${fixture.id}-append.json`) && files.has(`${fixture.id}-state.json`)) verifiedPairs++;
  }
}
assert.ok(verifiedCalls <= manifest.maxCalls);
console.log(JSON.stringify({ directory, verifiedCalls, verifiedPairs, promptAndScoreIntegrity: true }));
