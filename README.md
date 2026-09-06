# ds-maxpower

为 Pi 提供由命令控制的 **Trace as State（TaS）模式**。开启后，每个新任务先让
DeepSeek 独立推理两次，再把这两份轨迹放到原上下文之前，进入 Pi 正常回答和工具调用流程。

当前版本为 **v0.1.0 工程原型**。真实 API 和工具循环已经跑通；现有实验没有证明它能提高
真实编程任务成功率。模式默认关闭，开启后每个新任务会增加两次付费模型调用。

## 安装 Release

需要已安装 **Pi 0.85.1**，并在 Pi 中配置好 DeepSeek V4 的认证。
核心扩展使用 Pi 的模型连接，**不依赖 Kimi Code**。

从 [v0.1.0 Release](https://github.com/P-A-N-52/ds-maxpower/releases/tag/v0.1.0)
下载 `ds-maxpower-0.1.0.tgz` 或 `ds-maxpower-0.1.0.zip`。`SHA256SUMS` 提供两个资产的校验值。

将压缩包解到准备长期保留的目录。使用 tgz 时：

```sh
tar -xzf ds-maxpower-0.1.0.tgz
pi install "$(pwd)/package"
```

使用 zip 时：

```sh
unzip ds-maxpower-0.1.0.zip
pi install "$(pwd)/ds-maxpower-0.1.0"
```

安装后保留该解压目录。在要工作的项目目录启动 Pi：

```sh
pi --provider deepseek --model deepseek-v4-pro --thinking max
```

## 使用

```text
/tas on
检查 @src/example.ts 的边界条件，并修复发现的问题
/tas status
/tas off
```

- `/tas on`：开启当前会话的模式，之后正常输入任务即可。
- `/tas off`：关闭模式并取消当前 TaS 任务。
- `/tas status` 或 `/tas`：查看状态，不发起模型请求。
- Esc：通过 Pi 原生路径取消；新建、恢复会话和重载插件均默认关闭模式。

首遍没有工具，只能读取当前有效上下文和显式 `@文件` 的冻结快照；最终阶段仍可使用
Pi 的正常工具。含空格的文件路径写作 `@"src/my file.ts"`。当前仅支持文本输入。

## 参数与验证范围

首版固定两次首遍，每次采用 max reasoning，输出最多 32,768 token，超时 10 分钟，
首遍不自动重试。每条轨迹最多保留 **50,000 Unicode 字符**，不是 50,000 token；
精确 token 裁剪尚未实现。总容量采用保守字节估算，超出预算会停止任务。

轨迹只在请求中前置，不写入持久会话；同一任务的工具续轮复用相同轨迹和文件快照。
每次运行会把输入、推理和用量归档到工作目录 `.pi/tas/`，这些记录可能含项目内容，
不属于 Release 资产。

已完成 41 项离线测试（扩展 27 项、API 评测器 14 项），以及一次真实 DeepSeek 验收：
两次首遍、一次 read 工具调用、一次最终回答，共 4 次 HTTP 请求。
这证明接入流程可用。另一个两题合成图实验中，各条件均答对，没有观察到准确率增益。
见 [验证摘要](docs/validation-0.1.0.json) 和
[实验结果](https://github.com/P-A-N-52/ds-maxpower/blob/v0.1.0/tas-lab/RESULTS.md)。

## 从源码开发

源码开发需要 Git 和 Node.js 22.19.0 或更新版本。
源码仓库包含扩展、独立 API 评测器和方案文档。Release 核心包用于加载扩展，
源码开发及 Kimi 便利启动器需要以下完整源码环境：

```sh
git clone https://github.com/P-A-N-52/ds-maxpower.git
cd ds-maxpower
npm run setup
npm run check
npm test
```

`setup` 准备固定提交的 Pi 源码和锁定依赖；普通测试不调用付费 API。
已有 Kimi Code 官方 DeepSeek V4 Pro 配置时，可从源码目录使用便利启动器：

```sh
node tas-extension/launch.mjs
```

该入口只读 Kimi 配置，通过子进程环境使用凭据；Pi 配置和会话保存在源码目录
`.tas-pi/`，工作目录保持启动时的目录。它是可选入口，核心扩展无需 Kimi 配置。

## 文档

- [扩展运行合同、归档和开发验收](tas-extension/README.md)
- [独立 API 实验使用说明](https://github.com/P-A-N-52/ds-maxpower/blob/v0.1.0/tas-lab/README.md)
- [实现方案与证据边界](https://github.com/P-A-N-52/ds-maxpower/blob/v0.1.0/tas-plan.md)
- [Trace as State 论文](https://arxiv.org/html/2609.02702v1)

本项目与 Pi、DeepSeek 及论文作者无隶属关系；论文中的结果不代表本项目的实测收益。
