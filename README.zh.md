# Agent 链上订单网络 · v0.6 开发者预览版

[English](README.md) | 简体中文

让用户已有的 Agent 理解需求、编写复杂订单、阅读和筛选公开订单，再由用户在原对话中确认 P2P 交易。接入方式是 **p2p-orders Skill + 一次性协议工具**，不要求使用本项目的客户端或另配模型。

订单和公开条款存在合约中，报价、锁款、交付及结算由参与者直接读写链。订单不是代币或 NFT；TESTUSD 仅为无价值测试支付币。项目方无需长期运营账户、目录、撮合、文件、模型或唤醒服务器。参与者仍需自己的宿主、执行环境、钱包、RPC 和期限监控。

**v0.6 已冻结功能，定位为开发者预览，不开放真实资金。** 本地完整交易、两个真实 Codex 会话交易，以及新会话接入和原会话唤醒已有验证；公共测试网部署、实际跨设备交易和其他宿主兼容性尚未验证。详见[已知限制](docs/known-limitations.md)。

## 安装与一键自测

需要 Node.js 24+、npm 和终端。首次安装需要访问 npm；默认自测不需要模型账号、钱包、测试 gas 或公共 RPC。

```sh
npm ci
npm run preview:verify
```

Windows PowerShell 如拦截 `npm.ps1`，将 `npm` 换成 `npm.cmd`。

`preview:verify` 顺序执行合约编译、自动测试、完整 Skill 工具演示和独立 Skill 打包；任一步失败都会停止。演示启动临时本地链，结束后停止自己启动的链进程。数据写入已忽略的 `.local-demo/`，其中包含随机开发钱包，**不要上传该目录**。

## 完整演示与实际 Agent 接入

```sh
# 复杂订单 → 分页发现 → 报价 → 确认锁款 → 交付 → 确认付款 → 按订单提款
npm run demo:skill
# 查看工具定义
node skills/p2p-orders/scripts/orders.mjs schema
# 生成可搬离仓库的 Skill 包，输出位置打印在终端
npm run package:skill
```

自动演示中的需求理解、用户授权和交付是测试夹具，实际链上动作由独立工具进程执行；它验证协议闭环，不代表模型能力测试。真实模型试跑的范围见[验证记录](docs/codex-live-trial.md)。

将生成的整个 `p2p-orders` 文件夹放入宿主支持的 Skill 位置，并安装包内运行时依赖：

```sh
npm --prefix "<Skill目录>/runtime" ci --omit=dev
node "<Skill目录>/scripts/orders.mjs" schema
```

宿主读取 [SKILL.md](skills/p2p-orders/SKILL.md)，在用户自己的环境中执行工具；公开发现可使用不含私钥的部署清单。交易需参与者自己的测试钱包和真实授权。只有文本补全能力、不能执行工具的宿主无法仅靠 Skill 交易。

## v0.6 固定范围

| 能力 | 交付内容 |
| --- | --- |
| 需求表达 | 宿主生成含必须项、排除项、条件、交付和验收标准的条款；工具校验并保留原文 |
| 公开发现 | 无钱包分页读完整订单，宿主理解候选；标签匹配仅为可选粗筛 |
| 人工确认交易 | 精确提案预览、报价、锁款、交付、确认、争议及按订单或明确全部范围提款 |
| 回执与恢复 | 逐笔回执、持久动作日志、钱包写入锁、只读断线恢复及重复提案核验 |
| 待办与唤醒 | 持久事件收件箱、截止提醒、一次性本地适配器；Codex 原会话收件核验 |
| 独立接入准备 | 测试身份、邀请核验、doctor、显式 Base Sepolia 配置、部署/领取工具和证据导出 |

范围外：必选自有客户端、业务代币、主网、生产托管、跨产品即装即用、海量检索承诺和自动验收扩展。v0.6 收尾仅接受阻断性修复与文档纠正。

## 文档

- [安装、自测、完整演示](docs/developer-preview.md)
- [已知限制](docs/known-limitations.md)
- [Agent / API 接入](docs/agent-skill.md) · [工具协议](docs/agent-tools.md)
- [恢复与唤醒](skills/p2p-orders/references/recovery.md)
- [真实会话验证](docs/codex-live-trial.md) · [版本记录](CHANGELOG.md)
- [部署清单（English）](docs/deployment-checklist.md)
- [后续可选公共测试网试点](docs/pilot-runbook.md)，不属于本次预览版完成条件

公开版只保留 v0.6 的 Skill、合约、pilot、恢复/唤醒和核心测试；旧的 trade CLI、确定性 agents、网页采集示例及对应测试/文档已移除。

## 许可证

MIT，详见 [LICENSE](LICENSE)。第三方依赖保留各自许可证。
