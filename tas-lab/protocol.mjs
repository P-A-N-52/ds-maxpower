import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(value).digest('hex');

export function serializeTraces(results, maxChars = 50000) {
  const accepted = results.map((result, index) => ({ result, index }))
    .filter(({ result }) => result.complete && result.reasoning.trim());
  if (accepted.length !== results.length) throw new Error('All source runs must finish with nonempty reasoning');
  const header = `These are ${accepted.length} independent first-attempt reasoning traces for the same problem. They may contain mistakes. Use them only as draft hints and verify against the original graph. Do not copy them into the final answer.`;
  return [header, ...accepted.map(({ result, index }) =>
    `<trace_start index="${index + 1}">\n${Array.from(result.reasoning).slice(0, maxChars).join('')}\n<trace_end>`)].join('\n\n');
}

export function buildPrompt(fixture, placement, trace = '') {
  const { context, question } = fixture;
  if (placement === 'first') return `${context}\n\n${question}`;
  if (!trace) throw new Error('Feedback conditions require a trace block');
  if (placement === 'state') return `${trace}\n\n${context}\n\n${question}`;
  if (placement === 'append') return `${context}\n\n${trace}\n\n${question}`;
  throw new Error(`Unknown placement: ${placement}`);
}

export function usageTotals(results) {
  const totals = { requests: results.length, completed: 0, missingUsage: 0, input: 0, cachedInput: 0,
    output: 0, reasoning: 0, requestSeconds: 0 };
  for (const result of results) {
    totals.completed += Number(result.complete);
    totals.requestSeconds += result.elapsedMs / 1000;
    if (!result.usage) { totals.missingUsage++; continue; }
    totals.input += result.usage.prompt_tokens ?? 0;
    totals.cachedInput += result.usage.prompt_cache_hit_tokens ?? result.usage.prompt_tokens_details?.cached_tokens ?? 0;
    totals.output += result.usage.completion_tokens ?? 0;
    totals.reasoning += result.usage.completion_tokens_details?.reasoning_tokens ?? 0;
  }
  // Snapshot: official DeepSeek Pro pricing on 2026-09-06, USD / 1M tokens.
  // Report both time bands; usage is authoritative, this is not a billing receipt.
  const uncached = totals.input - totals.cachedInput;
  totals.estimatedUsdOffPeak = (uncached * 0.66 + totals.cachedInput * 0.022 + totals.output * 1.98) / 1e6;
  totals.estimatedUsdPeak = totals.estimatedUsdOffPeak * 2;
  return totals;
}
