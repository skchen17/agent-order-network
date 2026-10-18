# 安全说明

本项目是未经过第三方安全审计的开发者预览，**真实资金未获批准**。默认支持本地开发链和 Base Sepolia 测试网；Base 主网 8453 的 Phase 1 工具需要显式 `allowMainnet`、外部签名器模块和 USDC，且尚未执行任何主网交易。主网真实资金必须满足[主网就绪门槛](docs/mainnet-readiness.md)。

Base USDC 可被 Circle 冻结或暂停；合约不可升级且没有管理员、rescue 或 pause。主网写入拒绝明文私钥。

## 报告漏洞

请使用 GitHub 仓库的私密漏洞报告功能（Security → Advisories），不要先公开创建 issue。报告中请包含：

- 受影响文件或合约函数；
- 复现步骤或最小示例；
- 可能影响的资金、权限或状态；
- 你希望公开披露的时间。

## 范围

重点范围包括 `contracts/`、`src/` 和 `skills/p2p-orders/`。已知限制（无隐私、评估方默认离线、仲裁超时退款、未审计、不可升级等）见 [docs/known-limitations.md](docs/known-limitations.md)。

## 不在范围

- 主网部署或真实资产损失；
- 第三方 RPC、水龙头、宿主模型或依赖库自身的问题；
- 社会工程、密钥泄露和用户误操作。

修复前请不要公开利用细节。
