import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'smol-toml';

export const SYSTEM = 'Solve the supplied graph problem using only its data. Do not use tools. Return the requested Final Answer JSON array.';

export async function* sseData(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      const data = block.split(/\r?\n/).filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).replace(/^ /, '')).join('\n');
      if (data) yield data;
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) throw new Error('Incomplete SSE frame');
}

export async function createClient({ configPath = join(homedir(), '.kimi-code/config.toml'),
  modelKey = 'deepseek/deepseek-v4-pro', fetchImpl = fetch } = {}) {
  let config;
  try {
    config = parse(await readFile(configPath, 'utf8'));
  } catch {
    // TOML parser diagnostics include source lines, which may contain credentials.
    throw new Error('Unable to read or parse local Kimi configuration');
  }
  const model = config.models?.[modelKey];
  const provider = config.providers?.[model?.provider];
  if (!model || model.provider !== 'deepseek' || provider?.type !== 'openai') {
    throw new Error('Expected the existing deepseek model with Kimi provider type=openai');
  }
  const base = new URL(provider.base_url);
  if (base.origin !== 'https://api.deepseek.com' || base.username || base.password || base.search || base.hash) {
    throw new Error('Expected the configured official DeepSeek endpoint');
  }
  const key = provider.api_key;
  if (typeof key !== 'string' || !key || key.includes('\n')) throw new Error('Missing local DeepSeek API key');
  const endpoint = `${base.href.replace(/\/$/, '')}/chat/completions`;
  const info = Object.freeze({ modelKey, model: model.model, endpoint, protocol: 'chat-completions',
    contextWindow: model.max_context_size, configuredOutputLimit: model.max_output_size });

  async function request(prompt, { maxTokens = 16384, signal, timeoutMs = 600000 } = {}) {
    const startedAt = new Date().toISOString();
    const started = performance.now();
    const result = { startedAt, model: info.model, finishReason: null, text: '', reasoning: '', usage: null,
      complete: false, error: null, elapsedMs: 0, maxTokens };
    try {
      const response = await fetchImpl(endpoint, {
        method: 'POST', redirect: 'error',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: info.model, messages: [
          { role: 'system', content: SYSTEM }, { role: 'user', content: prompt },
        ], thinking: { type: 'enabled' }, reasoning_effort: 'max', max_tokens: maxTokens,
        stream: true, stream_options: { include_usage: true } }),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`DeepSeek HTTP ${response.status}`);
      let done = false;
      for await (const data of sseData(response.body)) {
        if (data === '[DONE]') { done = true; break; }
        const event = JSON.parse(data);
        if (event.error) throw new Error('DeepSeek returned a stream error');
        if (event.model) result.model = event.model;
        if (event.id) result.responseId = event.id;
        if (event.usage) result.usage = event.usage;
        const choice = event.choices?.[0];
        if (typeof choice?.delta?.reasoning_content === 'string') result.reasoning += choice.delta.reasoning_content;
        if (typeof choice?.delta?.content === 'string') result.text += choice.delta.content;
        if (choice?.finish_reason) result.finishReason = choice.finish_reason;
      }
      result.complete = done && result.finishReason === 'stop' && result.usage !== null;
      if (!done) result.error = 'Stream ended without [DONE]';
      else if (!result.usage) result.error = 'Stream ended without usage';
    } catch (error) {
      result.error = String(error.message ?? error).replaceAll(key, '[REDACTED]');
    }
    result.elapsedMs = Math.round(performance.now() - started);
    return result;
  }
  return { info, request };
}
