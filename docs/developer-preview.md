# v0.6 开发者预览：安装、自测与演示

版本：0.6.0。范围以 [README](../README.md#v06-固定范围) 为准，冻结后只修阻断问题和文档。公共测试网、跨设备和扩大试点留待条件具备后验证，不继续扩展为 v0.6 发布门槛。

## 1. 环境与安装

使用 Node.js 24 或更新兼容版本及 npm。从仓库根目录执行：

```sh
node --version
npm --version
npm ci
```

Windows PowerShell 如遇 `npm.ps1` 被执行策略阻止，使用 `npm.cmd`。Node 内置 SQLite 在部分版本会打印实验性提示，该提示本身不表示失败。首次安装需要访问 npm registry；默认验证不需要模型账号、额外钱包或公共测试 gas。

不要将真实钱包放入示例配置。目前没有项目方公共部署邀请，不能把本地配置当成跨设备网络。Base 主网 8453 + USDC 的 Phase 1 工具默认关闭、要求外部签名器、未经审计；不要使用真实资金。见[主网就绪说明](mainnet-readiness.md)。

## 2. 自测

```sh
npm run preview:verify
```

该入口依次运行 `npm test`、完整 Skill 演示及独立打包；失败返回非零退出码。测试覆盖合约状态/提款范围、工具授权边界、动作恢复、持久待办、唤醒回执及测试网接入校验。模拟 chainId=84532 的测试验证分支逻辑，不代表访问公共网。

单独执行：

```sh
npm test
npm run demo:skill
npm run package:skill
```

CI 配置使用 Node 24，在 Windows 与 Ubuntu 执行同一入口；不调用付费模型、不连接真实钱包、不部署公共合约。远端 CI 状态以 GitHub 实际运行结果为准。

## 3. 完整演示

`demo:skill` 自动启动临时本地链和随机开发钱包，通过独立一次性工具进程完成：

1. 宿主夹具生成复杂条款；未确认的执行请求被拒绝，准备提案不付款。
2. 发布目标与干扰订单；无私钥参与者分页读取两单完整条款。
3. 供应方报价 1.5 TESTUSD；买方夹具授权选定与锁款。
4. 供应方提交交付，买方从链上读取正文并校验哈希。
5. 唤醒失败、超时保留待办；成功收件后确认，再次检查不重复投递；只读恢复锁款动作。
6. 买方夹具确认付款，供应方仅提取该订单应收款；取消干扰订单。

预期摘要：`keylessDiscovery`、`fullTermsPreserved`、`deliveryVerified`、`unifiedReceipts`、`durableWake`、`recoveryReadOnly` 为 true；主订单 `status=4`（Completed），`sellerBalance="1500000"`（6 位小数的 1.5 TESTUSD），`escrow="0"`、`credits="0"`。结果目录打印在终端，每次独立生成；链停止后不能用其配置继续交易。

需求理解、授权和交付使用夹具；演示唤醒使用本地测试适配器，不代表真实模型能力或 Codex 会话唤醒。公开的[本轮验证摘要](evidence/v0.6/verification.json)只保留可共享结果，原始运行目录不随源码提交。

## 4. 分发 Skill

`package:skill` 打印新建包的 skill 与 runtime 路径，已有输出目录不覆盖。包内包含 Skill、四个脚本入口、协议参考、SDK 源码、四份合约产物及锁文件，不含钱包、宿主认证、运行日志、node_modules 或系统定时任务。

```sh
npm --prefix "<skill目录>/runtime" ci --omit=dev
node "<skill目录>/scripts/orders.mjs" schema
```

schema 应返回 0.6.0 的 14 个工具定义。工具 JSON stdout 与诊断 stderr 分离，失败退出非零。参与者仍需自行配置宿主执行、网络与授权；参见[接入指南](agent-skill.md)。

## 5. 真实宿主与后续试点

两个真实 Codex 会话已在同机本地链完成交易；新真实会话验证过独立 join、doctor 和恢复原会话只读处理事件。见[验证记录](codex-live-trial.md)。可选择自行复查真实唤醒：

```sh
node scripts/real-wake-trial.mjs --codex "<Codex CLI可执行文件绝对路径>" --out "<新的证据目录>"
```

这使用操作者自己的 CLI 认证、模型额度和执行权限，不在默认自测或 CI 中执行。原始会话日志、钱包不得公开；该试跑仍是同机临时链，不证明公共网或跨设备可用。公共试点步骤保存在[试点流程](pilot-runbook.md)，目前不要求预览版用户领取 gas 或寻找第二台设备。

## 常见问题

| 现象 | 处理 |
| --- | --- |
| SQLite 或语法导入失败 | 检查实际终端 PATH 中的 Node，使用 Node 24+ 重新 npm ci |
| 缺合约产物 | 三个推荐 npm 入口会编译；直接调底层脚本前运行 npm run compile |
| 状态目录不可写 | 用 --state-dir 指定自己的可写持久目录；同一钱包恢复保持原目录 |
| 端口/子进程启动失败 | 检查进程启动权限和端口占用；不要终止不属于本次演示的进程 |
| npm 下载失败 | 检查网络、代理与 registry；不要删除锁文件绕过依赖版本 |
| 交易输出丢失、状态未决 | 原 actionId 只读恢复并等待确认，不换目录或盲目重发 |

提交源码时排除 `.local-demo/`、`.agent-tools/`、环境配置、钱包、原始模型日志和 RPC 令牌。公开示例与操作者试点配置应分别保存。
