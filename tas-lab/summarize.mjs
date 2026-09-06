import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { usageTotals } from './protocol.mjs';

const json = async path => JSON.parse(await readFile(path, 'utf8'));
const clean = value => String(value).replace(/[|`\r\n]/g, ' ');
const percent = value => value === null ? '—' : `${(value * 100).toFixed(2)}%`;
const number = value => value === undefined || value === null ? '—' : value.toLocaleString('en-US');
const status = call => !call ? 'unrun' : call.complete ? 'completed' : 'partial';
const score = (call, metric) => call.complete ? call.score?.[metric] ?? 0 : 0;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const table = (headers, rows) => [
  `| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`,
  ...rows.map(row => `| ${row.join(' | ')} |`), '',
].join('\n');

function observed(calls, planned) {
  return { planned, observed: calls.length, completed: calls.filter(call => call.complete).length,
    partial: calls.filter(call => !call.complete).length, unrun: planned - calls.length,
    em: mean(calls.map(call => score(call, 'em'))), f1: mean(calls.map(call => score(call, 'f1'))) };
}

function cost(totals, field, incomplete = false) {
  return `$${totals[field].toFixed(6)}${totals.missingUsage || incomplete ? '（部分小计）' : ''}`;
}

function usageRow(label, calls, incomplete = false) {
  const totals = usageTotals(calls);
  const missingReasoning = calls.filter(call => call.usage?.completion_tokens_details?.reasoning_tokens == null).length;
  return [label, calls.length, number(totals.input), number(totals.cachedInput), number(totals.output),
    `${number(totals.reasoning)}${missingReasoning ? `（${missingReasoning} 次未报告）` : ''}`,
    (totals.requestSeconds).toFixed(2), totals.missingUsage,
    cost(totals, 'estimatedUsdOffPeak', incomplete), cost(totals, 'estimatedUsdPeak', incomplete)];
}

function elapsedSpan(calls) {
  const intervals = calls.map(call => [Date.parse(call.startedAt), call.elapsedMs])
    .filter(([start, elapsed]) => Number.isFinite(start) && Number.isFinite(elapsed));
  return intervals.length ? (Math.max(...intervals.map(([start, elapsed]) => start + elapsed))
    - Math.min(...intervals.map(([start]) => start))) / 1000 : null;
}

export async function summarizeRun(runDirectory, smokeDirectory) {
  const runDir = resolve(runDirectory);
  const smokeDir = smokeDirectory ? resolve(smokeDirectory) : null;
  if (smokeDir === runDir) throw new Error('Smoke and evaluation directories must be different');
  const [summary, manifest, fixtures, files] = await Promise.all([
    json(join(runDir, 'summary.json')), json(join(runDir, 'manifest.json')),
    json(join(runDir, 'fixtures.json')), readdir(runDir),
  ]);
  if (manifest.mode !== 'evaluate' || fixtures.length !== summary.plannedCases) {
    throw new Error('Expected an evaluation with matching summary and fixtures');
  }
  const slots = fixtures.flatMap(fixture => ['first-1', 'first-2', 'append', 'state']
    .map(condition => `${fixture.id}-${condition}`));
  const available = new Set(files);
  const calls = await Promise.all(slots.filter(label => available.has(`${label}.json`))
    .map(async label => {
      const call = await json(join(runDir, `${label}.json`));
      if (call.label !== label || !Number.isFinite(call.elapsedMs)) throw new Error(`Invalid call record: ${label}`);
      return call;
    }));
  const byLabel = new Map(calls.map(call => [call.label, call]));
  const get = (fixture, condition) => byLabel.get(`${fixture.id}-${condition}`);
  const select = conditions => fixtures.flatMap(fixture => conditions.map(condition => get(fixture, condition))).filter(Boolean);
  const first = select(['first-1', 'first-2']);
  const append = select(['append']);
  const state = select(['state']);
  const metrics = { first: observed(first, fixtures.length * 2),
    append: observed(append, fixtures.length), state: observed(state, fixtures.length) };
  const pairs = fixtures.filter(fixture => get(fixture, 'append')?.complete && get(fixture, 'state')?.complete);
  const smoke = smokeDir ? await Promise.all([
    json(join(smokeDir, 'summary.json')), json(join(smokeDir, 'smoke.json')),
  ]) : null;
  const smokeCalls = smoke ? [smoke[1]] : [];
  const allCalls = [...calls, ...smokeCalls];
  const models = new Map();
  for (const call of allCalls) {
    const model = call.model ?? '未报告';
    models.set(model, (models.get(model) ?? 0) + 1);
  }
  const completeCases = fixtures.filter(fixture => ['first-1', 'first-2', 'append', 'state']
    .every(condition => get(fixture, condition)?.complete)).length;
  const attemptedCases = fixtures.filter(fixture => ['first-1', 'first-2', 'append', 'state']
    .some(condition => get(fixture, condition))).length;
  const cell = call => call ? `${status(call)} · ${percent(score(call, 'em'))} / ${percent(score(call, 'f1'))}` : 'unrun · —';
  const usageHeaders = ['范围', '调用', '输入 token', '其中缓存命中', '输出 token', '其中推理 token',
    '请求耗时合计/秒', '缺 usage 调用', '低峰 USD', '高峰 USD'];
  const lines = [
    '# TaS 合成图任务试验报告', '',
    `计划 ${fixtures.length} 个样例；已尝试 ${attemptedCases} 个；四次调用均完成 ${completeCases} 个；state/append 完成配对 ${pairs.length} 个。`, '',
    `本报告从每次调用的 JSON 独立汇总分数和用量。配置模型：\`${clean(manifest.client?.model ?? '未记录')}\`。`, '',
    `返回模型（responseModel，取自调用记录的 model 字段）：${[...models].map(([model, count]) => `\`${clean(model)}\` × ${count}`).join('；') || '尚无调用'}。`, '',
    ...(models.size > 1 ? ['返回模型名称不一致；本批结果不能视为已经确认的单模型对照。', ''] : []),
    '## 样例结果', '',
    '每格显示完成状态及 EM / F1。completed 表示协议完整结束；partial 表示已执行但未完整结束，按零分计；unrun 表示未运行，不当作实测错误。', '',
    table(['样例', '整体状态', 'first 1', 'first 2', 'append', 'state'], fixtures.map(fixture => {
      const row = ['first-1', 'first-2', 'append', 'state'].map(condition => get(fixture, condition));
      const overall = row.every(call => call?.complete) ? 'completed' : row.some(Boolean) ? 'partial' : 'unrun';
      return [clean(fixture.id), overall, ...row.map(cell)];
    })),
    '## 覆盖率与 observed 分数', '',
    'observed 的分母仅为已执行调用，包含 partial 的零分；unrun 不进入分母。first 是两次独立首遍的逐调用均值，同时计算 EM 和 F1。计划覆盖单独列出，未把未运行项的零分称为实测准确率。', '',
    table(['条件', '计划调用', '已执行', 'completed', 'partial', 'unrun', 'observed EM', 'observed F1'],
      Object.entries(metrics).map(([condition, result]) => [condition, result.planned, result.observed,
        result.completed, result.partial, result.unrun, percent(result.em), percent(result.f1)])),
    `完成配对的 ${pairs.length} 个样例中，append EM / F1 为 ${percent(mean(pairs.map(f => score(get(f, 'append'), 'em'))))} / ${percent(mean(pairs.map(f => score(get(f, 'append'), 'f1'))))}，state 为 ${percent(mean(pairs.map(f => score(get(f, 'state'), 'em'))))} / ${percent(mean(pairs.map(f => score(get(f, 'state'), 'f1'))))}。这是完整配对的描述视图，不能替代上面的覆盖情况。`, '',
    '## 用量、耗时与实验总支出', '',
    table(usageHeaders, [usageRow('评测实际调用（首遍仅计一次）', calls),
      ...(smoke ? [usageRow(`冒烟（${smoke[0].passed ? '通过' : '未通过'}）`, smokeCalls), usageRow('含冒烟的实验总计', allCalls)] : [])]),
    `评测从首个请求开始至最后请求结束的墙钟跨度：${elapsedSpan(calls) === null ? '未记录' : `${elapsedSpan(calls).toFixed(2)} 秒`}。请求耗时合计会相加并行首遍的耗时，不等于墙钟耗时。`, '',
    '输入 token 已包含缓存命中部分；输出 token 已包含推理 token，推理不重复计费。缺失 usage 的调用未猜测费用，任何费用行只要存在 missingUsage 就标为部分小计；推理明细未报告也不等于没有推理。', '',
    '费率采用本实验记录的 2026-09-06 DeepSeek Pro 快照：低峰每百万 token 未缓存输入 $0.66、缓存输入 $0.022、输出 $1.98；高峰为其两倍。两列是时段情景估算，不是账单金额。', '',
    '[费率来源](https://api-docs.deepseek.com/quick_start/pricing/)', '',
    '## 各策略独立部署成本', '',
    '每个策略都需要两次首遍，加上自己的最终一遍。因此下面的 append 和 state 各自计入首遍成本；实验实际运行时共享了这些首遍，不能把下面两行相加当作实验总支出。含未运行槽位的策略行只是已执行部分的小计。', '',
    table(usageHeaders, ['append', 'state'].map(condition => {
      const selected = select(['first-1', 'first-2', condition]);
      const complete = fixtures.filter(fixture => ['first-1', 'first-2', condition]
        .every(slot => get(fixture, slot)?.complete)).length;
      return usageRow(`${condition}：source 2 + final（完整 ${complete}/${fixtures.length} 例）`, selected,
        selected.length < fixtures.length * 3);
    })),
    '## 各调用明细', '',
    table(['调用', '状态', '结束原因', '输入', '缓存命中', '输出', '推理', '耗时/秒'], calls.map(call => [
      clean(call.label), status(call), clean(call.finishReason ?? '—'), number(call.usage?.prompt_tokens),
      number(call.usage?.prompt_cache_hit_tokens ?? call.usage?.prompt_tokens_details?.cached_tokens),
      number(call.usage?.completion_tokens), number(call.usage?.completion_tokens_details?.reasoning_tokens),
      (call.elapsedMs / 1000).toFixed(2),
    ])),
    '## 解释范围', '',
    `本试验事先固定 ${fixtures.length} 个合成图样例（原计划四例），样本很小；它只能检验流程并提供本批任务的描述性结果，不能证明普遍增益。`, '',
    '两次首遍的输入相同，append/state 使用相同的原文、同一组首遍推理及相同的末尾问题；只改变推理块相对原文的位置。首遍没有按答案正确性筛选。', '',
    '没有等预算 best-of-N 基线，也没有独立的等预算直接尝试对照；first 均值与需要三次调用的反馈策略不是等成本比较。成本受缓存和时段影响，耗时受并发与服务端波动影响。', '',
    '这是直接调用已配置 DeepSeek API 的合成任务试验，不包含另行开展的 Pi 扩展验收，也不是原论文复现。报告不包含原始推理内容。', '',
  ];
  const report = join(runDir, 'report.md');
  await writeFile(report, lines.join('\n'), { mode: 0o600 });
  return { report, plannedCases: fixtures.length, attemptedCases, completeCases, completedPairs: pairs.length,
    metrics, usage: usageTotals(allCalls) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2] || process.argv.length > 4) throw new Error('Usage: node summarize.mjs RUN_DIR [SMOKE_DIR]');
  console.log(JSON.stringify(await summarizeRun(process.argv[2], process.argv[3])));
}
