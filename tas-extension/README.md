# Pi TaS 模式

Pi 0.85.1 扩展，使用 DeepSeek V4。开启后，每个新用户任务先独立推理两次，
再把推理轨迹放到原上下文之前，交给 Pi 正常回答和使用工具。
它是可运行的工程原型；现有实验尚未证明它能提高真实编程任务成功率。

## Release 安装与命令

Release 核心包使用已有 Pi 的模型认证，不依赖 Kimi Code 或相邻 Pi 源码目录。
需要 Pi 0.85.1 和已配置的 DeepSeek V4 连接。按 [根目录安装说明](../README.md)
解压并 `pi install` 后，在要工作的目录运行：

```sh
pi --provider deepseek --model deepseek-v4-pro --thinking max
```

进入 Pi 后：

```text
/tas on
检查 @src/example.ts 的边界条件，并修复发现的问题
/tas status
/tas off
```

- 默认关闭。`/tas on` 开启当前会话；`/tas off` 关闭并取消当前 TaS 任务。
- `/tas` 等同于 `/tas status`，只查看状态，不触发模型请求。
- 开启后正常输入问题即可，不需要给每条消息加命令。
- Esc 使用 Pi 原生取消路径。新会话、恢复会话、重载插件都默认关闭。
- 正在运行普通任务时，需等它结束再开启模式。新的 steer/follow-up 问题进入请求时会重新采样。

也可直接加载源码目录中的扩展：`pi --extension /path/to/ds-maxpower/tas-extension/index.ts`，
并在 Pi 中选择已配置的 DeepSeek V4 模型。这里的 `/path/to/ds-maxpower` 替换成实际路径。

## 输入与运行合同

1. 新任务首次进入 `context` 时，冻结全部有效消息、系统提示、模型和显式引用的文本文件。
2. 两次首遍顺序运行，读取相同的冻结输入，不提供工具；每次 `reasoning_effort=max`，
   输出上限 32,768 token、超时 10 分钟、请求重试次数 0。
3. 仅接受正常结束且包含可见 thinking 的首遍。错误、取消、输出截断、空 thinking 均停止本次任务。
4. 每条 thinking 最多保留 50,000 Unicode 字符，序列化为一份 T。
   最终请求为 `[T, 原有效上下文, 后续工具消息]`；最终仍使用 max reasoning，
   每次输出最多 32,768 token。最终阶段沿用 Pi 的工具和原生重试设置。
5. 同一任务的工具续轮复用同一份 T 和文件快照，不再生成两次首遍。
   T 只注入请求，不插入持久会话消息；新任务重新采样。

文件引用须以空白分隔，例如 `查看 @src/a.ts 的实现`，含空格时使用 `@"src/my file.ts"`。
引用路径按原样解释，路径后不要直接连句号或逗号。每个文件最多 256 KiB，总计最多 512 KiB；
只接受普通 UTF-8 文本文件。没有引用的仓库文件不会被首遍自动读取，最终仍可正常使用工具访问。
已有历史消息、工具配对及其他扩展追加的 custom message 保留原顺序。

容量检查覆盖系统提示、消息、文件、T、工具定义及输出预留，使用 UTF-8 序列化字节估算加
4,096 余量，限制在窗口的 80% 内。它是保守工程估算，**不是精确 tokenizer**。
预算不足会在发送前停止，不静默删除原文。严格的每条 50,000 **token** 裁剪仍待实现；
当前字符上限与独立实验一致，不能混称。

需要继续同一任务的压缩会停止任务，避免旧轨迹配上被替换的输入；任务结束后的压缩正常进行。
其他会改写 `context` 或 provider payload 的扩展组合尚未全面验收。首版不支持图片输入。

## 归档

每次运行写入工作目录 `.pi/tas/<run-id>/`：

- `input.json`：冻结输入、文件路径、SHA256。
- `1-first-1.json`、`2-first-2.json`：首遍原始内容、终止状态和 usage。
- `trace.json`：实际注入的 T。
- 后续 `*-final.json`：最终回答及工具循环中的模型响应。
- `run.json`：运行状态、参数、逐次用量和总用量；取消后的迟到响应只补记用量，不回退终态。

归档含任务文本和模型推理。文件按 0600 创建；不保存模型认证头或 provider 原始报错体。
Pi usage 的 `input` 与 `cacheRead` 分开计数；模型目录中的成本估计不是核实后的账单。

## 验证

从完整源码仓库根目录准备开发依赖并验证：

```sh
npm run setup
npm run check
npm test
```

普通测试完全离线，不运行付费 API。扩展的 27 项测试覆盖文件冻结、预算、归档终态、
真实 Pi loader/SDK 接入、两次采样、工具复用、开关、原生取消、custom context 和自动压缩。
加上独立 API 评测器的 14 项，共 41 项测试。终端实际验证了模式命令和状态栏。

2026-09-06 DeepSeek 实测通过：2 次首遍 + 1 次 read 工具调用 + 1 次最终回答，
共 4 次 HTTP 请求、约 9.1 秒。未缓存输入 2,248、缓存输入 2,048、输出 436 token。
断言检查了实际 HTTP body 的模型、max reasoning、32,768 输出上限、相同首遍输入、
轨迹前置及工具续轮复用；预先取消的真实 provider 调用没有发出 HTTP 请求。
可分发结果见 [v0.1.0 验证摘要](../docs/validation-0.1.0.json)。原始记录保留在实验机器的
`tas-extension/runs/2026-09-06T09-06-53.899Z/`，不随源码仓库或 Release 分发。

显式运行付费验收（最多 4 个请求，只读取测试目录的合成文件）：

```sh
TSX_TSCONFIG_PATH=pi/tsconfig.json node --import ./pi/node_modules/tsx/dist/loader.mjs tas-extension/live-smoke.mjs --live
```

上述付费验收需要本机 Kimi Code 的官方 `deepseek/deepseek-v4-pro` 配置。
它使用完整源码开发环境，不属于 Release 核心包的安装步骤。

## 可选 Kimi 源码启动器

在完整源码仓库完成 `npm run setup` 后，已有 Kimi Code 官方 DeepSeek V4 Pro 配置的用户
可在要工作的目录运行源码启动器，例如从仓库根目录执行：

```sh
node tas-extension/launch.mjs
```

在其他工作目录使用启动器的实际路径。它只读 Kimi Code 的
`deepseek/deepseek-v4-pro` 配置，通过子进程环境变量使用凭据；不把密钥写入参数、
运行归档或 Pi 认证文件。Pi 配置和会话使用源码仓库 `.tas-pi/`，工作目录保持启动时的目录。

该源码入口依赖相邻 `pi/` 的固定源码环境，TOML 解析器来自相邻 `tas-lab/` 的锁定依赖，
由根目录 `setup` 准备。核心扩展自身没有新增运行依赖，也不修改 Pi 源码。
