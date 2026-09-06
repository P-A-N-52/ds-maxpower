import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, SYSTEM } from './client.mjs';
import { makeCalibrationFixtures, makeFixtures, scoreAnswer } from './fixtures.mjs';
import { buildPrompt, hash, serializeTraces, usageTotals } from './protocol.mjs';

const root = fileURLToPath(new URL('.', import.meta.url));
const mode = process.argv[2];
if (!['smoke', 'evaluate', 'calibrate'].includes(mode)) throw new Error('Usage: node run.mjs smoke|evaluate|calibrate [output-directory]');
const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
const out = resolve(process.argv[3] ?? join(root, 'runs', `${stamp}-${mode}`));
await mkdir(dirname(out), { recursive: true });
await mkdir(out, { recursive: false });
const save = async (name, data) => writeFile(join(out, name), `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const client = await createClient();
const calls = [];
const MAX_CALLS = mode === 'smoke' ? 1 : mode === 'calibrate' ? 8 : 16;
const MAX_INPUT_BYTES = mode === 'calibrate' ? 2_000_000 : 4_000_000;
const MAX_OUTPUT_TOKENS = mode === 'smoke' ? 2048 : mode === 'calibrate' ? 32768 : 16384;
let reservedBytes = 0;
await save('manifest.json', { schema: 1, mode: mode === 'smoke' ? 'smoke' : 'evaluate',
  profile: mode === 'calibrate' ? 'capacity-calibration' : mode, createdAt: new Date().toISOString(), client: client.info,
  reasoningEffort: 'max', maxOutputTokens: MAX_OUTPUT_TOKENS,
  sourceRuns: 2, maxTraceCharacters: 50000, maxCalls: MAX_CALLS, maxInputUtf8Bytes: MAX_INPUT_BYTES,
  temperature: 'provider default', retries: 0, system: SYSTEM,
  placements: { first: '[x,q]', append: '[x,T,q]', state: '[T,x,q]' },
  pricingSource: 'https://api-docs.deepseek.com/quick_start/pricing/',
  scope: 'Synthetic graph pilot; direct configured API, not a Pi extension or paper replication',
  sourceHashes: Object.fromEntries(await Promise.all(['run.mjs', 'client.mjs', 'protocol.mjs', 'fixtures.mjs']
    .map(async file => [file, hash(await readFile(join(root, file)))]))),
});

async function call(label, prompt, fixture, maxTokens = MAX_OUTPUT_TOKENS) {
  const bytes = Buffer.byteLength(prompt + SYSTEM);
  if (calls.length >= MAX_CALLS || reservedBytes + bytes > MAX_INPUT_BYTES) throw new Error('Pilot request budget exhausted');
  if (controller.signal.aborted) throw new Error('Pilot cancelled');
  reservedBytes += bytes;
  const callIndex = calls.length;
  calls.push({ label, pending: true });
  console.log(JSON.stringify({ event: 'request_started', label, inputChars: prompt.length, call: callIndex + 1 }));
  await writeFile(join(out, `${label}.prompt.txt`), prompt, { mode: 0o600 });
  const result = await client.request(prompt, { maxTokens, signal: controller.signal });
  result.label = label;
  result.promptHash = hash(prompt);
  result.inputUtf8Bytes = bytes;
  result.score = fixture ? scoreAnswer(result.text, fixture.expected) : null;
  if (!result.complete && result.score) result.score = { ...result.score, em: 0, f1: 0, valid: false };
  calls[callIndex] = result;
  await save(`${label}.json`, result);
  console.log(JSON.stringify({ event: 'request_finished', label, complete: result.complete,
    finishReason: result.finishReason, reasoningChars: result.reasoning.length, score: result.score,
    usage: result.usage, elapsedSeconds: result.elapsedMs / 1000, error: result.error }));
  return result;
}

if (mode === 'smoke') {
  const result = await call('smoke', 'Given edges A -> B, B -> C, and A -> D, return the nodes at shortest directed distance 2 from A. Reply exactly as Final Answer: ["node"].', null, 2048);
  const score = scoreAnswer(result.text, ['C']);
  const passed = result.complete && result.reasoning.trim().length > 0 && score.em === 1;
  await save('summary.json', { passed, score, usage: usageTotals(calls) });
  console.log(JSON.stringify({ event: 'smoke_complete', passed, output: out }));
  if (!passed) process.exitCode = 1;
} else {
  const fixtures = mode === 'calibrate' ? makeCalibrationFixtures() : makeFixtures();
  await save('fixtures.json', fixtures);
  const outcomes = [];
  try {
    for (let i = 0; i < fixtures.length; i++) {
      const fixture = fixtures[i];
      const firstPrompt = buildPrompt(fixture, 'first');
      const sources = await Promise.all([0, 1].map(index => call(`${fixture.id}-first-${index + 1}`, firstPrompt, fixture)));
      const outcome = { id: fixture.id, kind: fixture.kind, contextHash: hash(fixture.context),
        questionHash: hash(fixture.question), metadata: fixture.metadata, expected: fixture.expected,
        first: sources.map(result => ({ label: result.label, score: result.score, complete: result.complete })),
        append: null, state: null, error: null };
      outcomes.push(outcome);
      if (sources.some(result => !result.complete || !result.reasoning.trim())) {
        outcome.error = 'Feedback skipped because a source trace was incomplete or empty; case retained';
        await save('outcomes.partial.json', outcomes);
        // A capped/failed generation is diagnostic evidence; do not silently retry or buy more samples.
        break;
      }
      const trace = serializeTraces(sources);
      outcome.traceHash = hash(trace);
      await writeFile(join(out, `${fixture.id}.trace.txt`), trace, { mode: 0o600 });
      const order = i % 2 === 0 ? ['append', 'state'] : ['state', 'append'];
      for (const placement of order) {
        const prompt = buildPrompt(fixture, placement, trace);
        const result = await call(`${fixture.id}-${placement}`, prompt, fixture);
        outcome[placement] = { label: result.label, score: result.score, complete: result.complete };
      }
      await save('outcomes.partial.json', outcomes);
    }
  } catch (error) {
    await save('run-error.json', { error: error.message });
    process.exitCode = 1;
  }
  const scoreMean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const completed = outcomes.length === fixtures.length && outcomes.every(row =>
    row.first.every(result => result.complete) && row.append?.complete && row.state?.complete);
  const summary = { status: completed ? 'completed' : 'partial', earlyStopped: outcomes.length < fixtures.length || outcomes.some(row => row.error),
    plannedCases: fixtures.length, attemptedCases: outcomes.length,
    completedPairs: outcomes.filter(row => row.state?.complete && row.append?.complete).length,
    // Fixed planned denominator. Skipped/unrun cases contribute zero; no cherry-picking on success.
    first: { em: scoreMean(fixtures.flatMap(f => {
      const row = outcomes.find(o => o.id === f.id);
      return [0, 1].map(index => row?.first[index]?.score?.em ?? 0);
    })) },
    append: { em: scoreMean(fixtures.map(f => outcomes.find(o => o.id === f.id)?.append?.score?.em ?? 0)),
      f1: scoreMean(fixtures.map(f => outcomes.find(o => o.id === f.id)?.append?.score?.f1 ?? 0)) },
    state: { em: scoreMean(fixtures.map(f => outcomes.find(o => o.id === f.id)?.state?.score?.em ?? 0)),
      f1: scoreMean(fixtures.map(f => outcomes.find(o => o.id === f.id)?.state?.score?.f1 ?? 0)) },
    outcomes, usage: usageTotals(calls.filter(result => !result.pending)),
    reservedInputBytes: reservedBytes, output: out };
  await save('summary.json', summary);
  console.log(JSON.stringify({ event: completed ? 'evaluation_complete' : 'evaluation_partial', ...summary, outcomes: undefined }));
  if (!completed) process.exitCode = 2;
}
