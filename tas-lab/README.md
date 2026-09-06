# TaS API pilot

Small, reproducible experiment for Trace as State, using the existing Kimi Code
DeepSeek connection. This is an API experiment, not a Pi extension or a replication
of the paper's published benchmark scores.

See [2026-09-06 results](RESULTS.md) for the completed smoke, capped long pilot,
and separate two-case calibration batch.

## Run

Requires Node.js 22+ and a local `~/.kimi-code/config.toml` containing
`models."deepseek/deepseek-v4-pro"` backed by the `deepseek` provider with
`type = "openai"` and an official `https://api.deepseek.com` base URL.

```sh
npm ci --ignore-scripts
npm test
npm run smoke
npm run evaluate
# Separate capacity calibration after the long pilot hit its output cap:
npm run calibrate
```

The `smoke`, `evaluate`, and `calibrate` commands make **paid API requests**. The smoke test makes one request
with a 2,048 output-token cap. Evaluation makes at most 16 requests with a 16,384
output-token cap each. All use `deepseek-v4-pro`, enabled thinking, and `max`
reasoning effort. Temperature uses the provider default.

`npm run calibrate` is a separate two-case batch, with 24k/60k context characters,
new fixed seeds, eight requests maximum and a 32,768 output-token cap. It does not
reuse or overwrite the original pilot's capped sources. Comparing these batches
cannot isolate context length from output-budget effects; calibration is only for
establishing a complete working pipeline.

The API key is read into memory; it is not copied into this directory, arguments,
logs, or request artifacts. Kimi configuration and Pi source are not modified.
Only generated graph data is sent. Automatic retries, model tools, external file
reads by the model, and existing conversation history are absent.

## Fixed experimental design

Four seeded fixtures cover incoming-edge retrieval (24 or 40 answer nodes) and
exact shortest-distance BFS (5 or 7 edges, 24 answer nodes), with approximately
120,000 or 300,000 ASCII context characters. Nodes have uniform row formatting and
out-degree, and relevant rows are shuffled among distractors. An independent graph
parser and oracle validate the complete fixtures in unit tests.

For each fixture:

1. Run two independent first passes on `[x, q]`. These are also the single-pass
   baseline observations; neither sees the other response.
2. Retain both completed reasoning traces regardless of answer correctness.
   Clip each to 50,000 Unicode characters and serialize once into T.
3. Run append on `[x, T, q]` and state on `[T, x, q]`. The original context x,
   final question q, and serialized T are byte-identical across this pair.

The two source requests are concurrent. Feedback requests are sequential, with
their order alternated between fixtures. Caching is managed by DeepSeek; it is not
disabled. Each API request is stateless. No chat-history compression is involved.

The graph context and question are separate strings. Expected answers and oracle
metadata are retained locally and are never included in prompts. No fixture is
selected based on model accuracy. The model returns a single `Final Answer:` JSON
array. Exact match ignores array order. Set F1 provides partial-credit diagnosis.
Malformed, ambiguous, duplicate-containing, or nonterminal responses receive zero.

## Limits and stopping

- At most 16 evaluation requests and 4,000,000 cumulative UTF-8 input bytes,
  including system text. Byte and character counts are **not** tokenizer counts.
- Calibration allows at most eight requests and 2,000,000 cumulative input bytes.
- Ten-minute timeout per request; Ctrl-C aborts active requests.
- If either source run is incomplete or has no reasoning, stop the pilot after
  retaining that case and its partial results. No failure is silently retried.
- Fixed planned denominators are eight first-pass observations and four per
  feedback condition. Missing/unrun observations receive zero in the planned
  aggregate; check `attemptedCases` and `completedPairs` before interpreting it.
  Calibration uses four first-pass observations and two per feedback condition.
  Current runner returns exit code 2 for a partial run, and records explicit status.
- A complete source trace may still be clipped for feedback. Raw reasoning is
  preserved separately, so clipping can be audited.

## Artifacts and interpretation

Each run gets a new directory under `runs/` with a manifest, frozen fixtures,
exact prompts, raw reasoning/final responses, usage, trace blocks, and summary.
The manifest records source hashes and request settings. Inputs and T also have
hashes. Existing runs are never overwritten. `runs/` is ignored by Git.

Generate a report that separates observed results from unrun slots:

```sh
node summarize.mjs runs/EXPERIMENT_DIRECTORY [runs/SMOKE_DIRECTORY]
node verify-run.mjs runs/EXPERIMENT_DIRECTORY
```

The initial 2026-09-06 long pilot used an earlier runner that exited successfully
after a source-cap failure; its `attemptedCases=1` and `completedPairs=0` establish
that it was incomplete. Its artifacts are preserved. Do not interpret unrun
append/state slots as measured zero accuracy.

Request usage is the accounting ground truth. Reasoning tokens are included in
completion tokens and are not charged twice. Cost estimates use the official
DeepSeek Pro price snapshot from 2026-09-06 and show off-peak and peak rates. They
are not billing receipts; when `missingUsage` is nonzero, costs are only known-usage
subtotals. The paired experiment shares source calls: evaluating both conditions
costs four calls per case, while deploying either condition alone costs three.

Four synthetic graph cases do not establish a statistically reliable advantage,
general coding capability improvement, or parity with the paper. There is only
one feedback response per condition per case, source count is two, generation is
capped, graph generation differs, and the current Pro model differs from the
paper's Preview. Caching and sequential scheduling also limit latency comparisons.
This pilot does not include an equal-cost best-of-N baseline or a real Pi-session
integration test. The separate [Pi extension](../tas-extension/README.md) has its
own lifecycle tests and live tool-loop acceptance; those do not establish coding
accuracy gains for this experiment. A distributable validation summary is kept in
[docs/validation-0.1.0.json](../docs/validation-0.1.0.json); raw `runs/` directories
remain local and are not included in the repository or Release assets.

## Sources

- [Trace as State paper, experiment setup](https://arxiv.org/html/2609.02702v1#S4.SS1)
- [DeepSeek Chat Completions API](https://api-docs.deepseek.com/api/create-chat-completion/)
- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/)

The paper uses 50,000 **characters** per trace. The separate project's proposed
50,000 **token** limit remains a future variant requiring a tokenizer-aware global
budget. This pilot deliberately names and records its character limit.
