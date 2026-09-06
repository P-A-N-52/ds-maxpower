# Trace as State 思路笔记

> **早期工作草稿，非发布结论。** 下文包含尚未核验的文献、占位链接和待验证判断，
> 也保留了实现前的设想。当前实现与证据边界以 [正式方案](tas-plan.md)、
> [扩展说明](tas-extension/README.md) 和 [实测结果](tas-lab/RESULTS.md) 为准。

> 设想：模型对问题先独立跑 N 遍思考 → 提取 CoT → 附加到问题前面 → 再丢给模型正式做。
> 思路来源：[Trace as State: Reasoning Traces as Conditional States for Long-Context Transformers](https://arxiv.org/abs/2609.02702)（Xu Zou, Jie Tang；Z.ai / 清华；2026-09-02）
> 本文档 = 论文拆解 + 相关文献地图 + 批判性分析 + 可做的方向。

---

## 1. 论文方法（TRACE AS STATE, TaS）

流程：read → compute → feedback → reread。

1. 同一道题独立跑 `ntr` 遍（论文用 **5 遍**），收集每遍的 **reasoning trace**（思考全文，不是最终答案）。
2. 序列化成文本块 T：固定分隔符 `<trace_start>/<trace_end>` + 固定前言（"以下是独立首试的推理轨迹，**可能有错，仅作草稿提示，请对照原文验证**"）。单条 trace 截断到前 50,000 字符。
3. 全新 pass，输入 `[T, x, q]`：T 在**长上下文 x 之前**，问题 q 仍在**最后**，重新生成答案。

**核心卖点是位置，不是多跑几遍**。对照组 TRACE APPEND 用相同的 T 但放上下文后 `[x, T, q]`。3 模型 × 3 基准 × 27 个指标组合，TaS 赢 26 个。

代表性数字（GraphWalks Parents，EM）：

| 模型 | 首遍 | Append | TaS |
|---|---|---|---|
| DeepSeek V4Pro Preview | 29.2 | 43.0 | **81.8** |
| GLM-5.2 | 66.4 | 83.2 | **100.0** |

## 2. 理论动机

- 条件状态更新任务：初始状态由条件 z 给出，再读信息序列 C。
- condition-first `[z, C]`：只需存当前状态，⌈b⌉ bit。
- condition-last `[C, z]`：读完 C 才知道该走哪条状态路径，最坏要存全部响应剖面，⌈b·2^b⌉ bit —— **指数级分离**（worst case，附录 A 有构造性证明）。
- 有限上下文 + 有限精度的因果 Transformer（含 KV cache）就是因果状态更新处理器。
- 长上下文推理的结构错配：有用的任务状态（活跃目标、搜索前沿、已排除假设）常在后段才出现，但前段表征已定型。→ 下一遍把状态放到上下文前面，"带着状态重读"。

## 3. 关键消融（复现/改进时的成败细节）

| 对照 | 结论 | 含义 |
|---|---|---|
| Answer Feedback（只放答案） | 有提升但远差于 TaS | 要的是 trace 里的**中间状态**，不是答案 |
| Random Trace（放别题的 trace） | 比不放还差 | 非格式效应；错误状态**有害** |
| Trace Only（无原文） | ≈ Append < TaS | 原文重读不可省；trace 是导读不是替代 |
| TaS vs Oracle@5 | **TaS 更高** | 第二遍有真实新计算，不只是选择 |
| trace 数 1→5 | 单调上升 | ntr 是 inference-scaling 旋钮 |
| Question First | Parents 大涨、BFS 平 | 收益本质 = 提前知道任务状态 |

## 4. 我们设想与论文的差异

1. "附加到问题前面" → 应为 `[T, x, q]`：T 最前，q 最后。这是长上下文专属技术；无长上下文时位置优势基本消失。
2. 取 CoT **全文**（截 50k 字符），需 API 暴露 reasoning trace。
3. 2-3 遍是性价比点；论文证据支持越多越好（1→5 单调）。
4. 前言免责文本重要，降低错误 trace 带偏风险。

## 5. 批判点

1. 理论是 worst-case 分离，实验是定性借用（论文自认），不是定量预测。
2. trace 是有损含噪的状态代理；矛盾 trace 如何取舍未研究。
3. 成本 ×(ntr+1)；且 T 在前**破坏对 x 的 prefix/KV 缓存复用**（Append 可缓存 x）。
4. 只验证长上下文（256K–1M）；短任务、多轮 agent 场景未测。
5. 与 self-consistency 正交：SC 答案层投票（并行聚合），TaS 状态层反馈（串行接力），可叠加。
6. 27 组合唯一例外：GLM-5.2 BFS F1 上 Append 高 0.8（但 EM 低）——方向稳健但非定律。

---

## 6. 相关文献地图

### A. 重读/重复家族（不带"算出的状态"的前驱）

- [Re2: Re-Reading Improves Reasoning](https://arxiv.org/abs/2309.06275)（EMNLP 2024）— 问题读两遍，用重复部分模拟双向注意力。
- [Prompt Repetition Improves Non-Reasoning LLMs](https://arxiv.org/abs/2512.14982)（Google Research, 2025.12）— 整 prompt 重复 `<x><x>`，非推理模型提升且不增加生成 token/延迟；与 TaS 同源于因果注意力的顺序盲区。
- [CoRe: Repetition of Misordered Context](https://arxiv.org/abs/2410.07103)（NAACL 2025）— 多跳推理中重复全文上下文补救支持文档乱序。
- [PartRep: Learning What to Repeat](https://arxiv.org/abs/2607.01792)（2026.07）— 学习该重复哪部分。
- 关系：TaS 消融中 Re2 是强基线但仍远低于 TaS —— **重复原始输入 < 携带推理状态**。

### B. 顺序敏感性证据（动机层）

- [Premise Order Matters in Reasoning](https://arxiv.org/abs/2402.08939)（ICML 2024）— 前提顺序符合推理顺序时最佳，乱序掉 30%+。
- [Lost in the Prompt Order](https://arxiv.org/abs/2601.0)（Ok & Lee, ACL 2026 Findings）— 选项在上下文后重复可部分缩小顺序差距，近乎"简陋版 append"。
- [Racing Thoughts](https://arxiv.org/abs/2410.02102)（NAACL 2025）— 上下文化错误源于层间竞态，早期表征定型太早。

### C. 自生成内容喂回上下文（最亲的一族）

- [ReContext](https://arxiv.org/abs/2607.02509)（UIUC, 2026.07）— training-free，用内部注意力挑证据 span **replay 到问题前**，128K +24.6%；重放的是原文证据而非自算状态。
- [Reflexion](https://arxiv.org/abs/2303.11366)（NeurIPS 2023）/ [Self-Refine](https://arxiv.org/abs/2303.17651)（2023）— 喂回反思/批评，通常追加在后（≈append 位）。
- [Analogical Prompting](https://arxiv.org/abs/2310.01714)（2023）— 先生成同类例题再解题，"自生成内容前置"早期版。
- [Buffer of Thoughts](https://arxiv.org/abs/2406.04271)（NeurIPS 2024）— 蒸馏思维模板跨题复用，喂回的是压缩的**跨题**状态。

### D. "trace 即状态"的理论/实证支撑

- [State over Tokens](https://arxiv.org/abs/2512.12777)（Levy, Ravfogel, Goldberg 等, 2025.12）— reasoning tokens = 外化计算状态而非忠实解释；TaS 概念地基。
- [Reasoning Traces Shape Outputs but Models Won't Say So](https://arxiv.org/abs/2603.20620)（ACL 2026）— 注入 hint 因果性改变输出且不被承认；双刃剑：trace 确实驱动后续计算，错误 trace 也悄悄带偏。
- [Making Reasoning Matter](https://arxiv.org/abs/2405.17499)（Paul et al., 2024）— 反向证据：模型不总忠实使用自己声明的中间步骤。
- [Expressive Power of Transformers with CoT](https://arxiv.org/abs/2402.12875)（Merrill & Sabharwal, 2024）— CoT 扩展表达能力。

### E. 架构层的同一个痒处

- [The Markovian Thinker / Delethink](https://arxiv.org/abs/2510.06557)（ICLR 2026）— 分块推理，携带固定大小文本状态跨 chunk，平方→线性；训练侧的 "trace as state"。
- [Recurrent-depth / latent reasoning](https://arxiv.org/abs/2502.05171)（Geiping et al., NeurIPS 2025）、[LoopFormer](https://arxiv.org/abs/2601.0)（ICLR 2026）、[LLaDA](https://arxiv.org/abs/2405.20329)（NeurIPS 2024）— 架构迭代实现"带后见之明重算早期表征"，需改训练；TaS 卖点恰是不用改。

### F. 并行家族（对照系）

- [Self-Consistency](https://arxiv.org/abs/2203.11171)（2022）— 独立跑 N 遍但只答案层投票。TaS > Oracle@5 说明串行状态反馈 ≠ 并行答案聚合，两维正交可叠加。

### 社区讨论

- [alphaxiv 综述](https://www.alphaxiv.org/abs/2609.02702)、[papers.cool](https://papers.cool/arxiv/2609.02702)、[chatpaper 中文评述](https://chatpaper.com/zh-CN/paper/340858)。论文 2026-09-02 挂出，暂无力度的第三方批判或独立复现。

---

## 7. 文献摊开后的判断

一条清晰的递进线：

**重复问题（Re2）→ 重复整个输入（Prompt Repetition）→ 重复上下文（CoRe）→ 重放选出的证据（ReContext）→ 重放自己算出的状态（TaS）**

前置内容信息量越来越大、越来越"加工过"。该设想站在这条线的最前沿，方向被多条独立证据收敛支持。

## 8. 没人填的坑（机会点）

1. **"重放什么"的谱系无人系统对比**：原文重复 / 证据 span / 答案 / 原始 trace / **压缩结构化状态**——最后一格是空的，TaS 只是 50k 字符硬截断。
2. **多轮迭代 TaS**（第三遍、第四遍）无人测，收敛性未知。
3. **非长上下文场景**（数学/代码短题）trace 前置是否有意义无数据——Prompt Repetition 提示收益主要来自顺序盲区，短输入盲区小。
4. **TaS × Self-Consistency** 叠加效果未知。
5. trace 间矛盾时的取舍机制（投票式 T？按置信度筛选？）。
6. 自适应 ntr：trace 收敛即停，省钱。

## 9. 若动手：最小原型要点

- 流水线：并行 N 次调用（开 reasoning）→ 收集 trace → 拼 T（前言+分隔符）→ `[T, x, q]` 第二遍 → 解析答案。
- 参数：ntr、截断长度、前言文本、placement（state/append 对照开关）。
- 复现基准：GraphWalks 256K（`openai/graphwalks`）、MRCR（`openai/mrcr`）。
- 依赖：任一暴露 reasoning trace 的 API（如 DeepSeek reasoning_content）。
