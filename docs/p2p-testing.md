# 独立 Agent 交易测试

买方和供应方是两个独立 Node.js 进程，使用各自的随机开发钱包和状态目录。它们通过同一条区块链交换需求、签名报价和少量公开交付数据。运行时不依赖项目运营方的报价服务器、索引服务器、外部数据库或文件下载服务。

目前 Agent 是确定性脚本，没有调用外部大模型，也没有连接公共测试网。本文中的四种基础场景使用固定快照；实际网址采集和独立复核见 [公开商品网页采集试点](live-product-pilot.md)。测试在同一电脑的不同进程间运行，尚未验证跨设备联网。

## 一键演示

在项目根目录执行：

```powershell
npm.cmd ci
npm.cmd run demo:p2p
```

控制台分别打印 chain、buyer、seller 的进程 ID。正常流程为：发布、发现、报价上链、锁款、提交、确认及提款。买方支付 1.5 TESTUSD，供应方收到相同金额，托管和待提款余额均清零。

```powershell
npm.cmd run demo:p2p -- --scenario all
npm.cmd run test:p2p
```

| 场景 | 断言 |
| --- | --- |
| success | 独立进程完成交付，支付金额正确 |
| restart | 买方发布后退出再启动；供应方锁款后退出再启动；最终只有一笔订单和一次报价 |
| nondelivery | 供应方故意不交付，买方在截止后全额退款并提款 |
| invalid-result | 供应方提交格式正确但价格错误的结果；买方发现不一致并提出异议，评估方失联超时后退款 |

退款场景由测试控制器推进本地链时间，避免真实等待。Agent 自身不调用开发链的时间控制接口。正常交付不依赖评估方在线；有争议时仍采用合约约定的评估或超时规则。

测试结束时自动停止两个 Agent 和临时链，生成的摘要标记为 localOnly。不会留下长驻中转服务，不进行公共链部署。

## 三个终端手动运行

终端一启动本地测试节点，保持它在本次交易期间运行：

```powershell
npm.cmd run local:network -- --out .local-demo/manual-001 --port 8545
```

输出目录包含公开的 deployment.json 及各自的 buyer/config.json、seller/config.json。每份角色配置只有该角色自己的开发私钥。节点仅绑定 127.0.0.1，不向公网开放开发 RPC。

终端二：

```powershell
npm.cmd run agent:buyer -- --config .local-demo/manual-001/buyer/config.json
```

终端三：

```powershell
npm.cmd run agent:seller -- --config .local-demo/manual-001/seller/config.json
```

完成后两个 Agent 自行退出，在终端一按 Ctrl+C 停止临时链。

不要重复使用已有部署的输出目录启动一条新链；选择 manual-002 等新目录。新链会重置链上状态，旧 Agent 状态不能在新链继续。程序通过部署 ID 和部署区块哈希拒绝混用。

## 恢复运行

Agent 每次关键操作保存自己的 state.json。用同一份配置重新运行时，会查询链上当前状态，已存在的订单不重新创建，已发布的报价不重复发布，已交付的订单不重新提交。买方还会通过 requestId 查询链上订单编号。

可分别验证两个恢复检查点：

```powershell
npm.cmd run agent:buyer -- --config .local-demo/manual-001/buyer/config.json --pause-after-publish
# 退出后去掉 pause 参数重新启动

npm.cmd run agent:seller -- --config .local-demo/manual-001/seller/config.json --pause-before-delivery
# 买方锁款后退出，去掉 pause 参数重新启动
```

每个角色钱包同时只运行一个实例。状态文件采用临时文件加 rename 写入，但尚未实现进程互斥锁。恢复测试覆盖上述检查点，尚未穷举网络断开及交易未确认时的所有故障。

## 数据与证明

- 输入由买方读取自身的 compact HTML fixture 后写入链。供应方不读取买方输入文件。
- 供应方从链上 inputURI 解码输入，检查模板与快照摘要，再独立计算结果。
- 结果作为 application/json data URI 上链，买方从链读取，检查内容哈希以及字段与原始快照的一致性。
- 签名报价通过 QuotePosted 事件传递，不需要买方 HTTP 收件箱。
- 小样例是公开数据；base64 不提供加密。512 字节限制包含整个 data URI。

`.local-demo/last-run.json` 指向最近演示的凭证目录。每个目录下有 summary.json、buyer/state.json、seller/state.json。summary 包含角色 PID、订单数、报价数、余额、最终状态及传输方式，不包含私钥。

角色配置含本地开发私钥，仅供临时链使用，不应上传 GitHub。Unix 的文件 mode 不能替代 Windows ACL；当前依靠本地目录与 gitignore 管理测试配置，未实现生产密钥保险库。

## 硬件和服务依赖

| 组件 | 当前本地测试 | 后续公共测试网 |
| --- | --- | --- |
| 区块链节点 | 测试控制器临时启动，或手动保持进程运行 | 连接公共或第三方 RPC，无需项目方自己托管区块链节点 |
| 买卖方 Agent | 各自运行、各自监控期限 | 同样由参与者运行 |
| 报价中转与订单搜索 | 直接读写合约和事件 | 可继续使用链；大规模查询再增加可替换索引 |
| 文件服务 | 小样例完整写入链 | 大文件需另选可替换存储或参与方传输 |
| 评估方 | 无常驻评估进程，异常测试走约定超时退款 | 真实争议需要约定评估方响应，或接受其失联后果 |

该方案降低对运营方长驻服务器的依赖，但参与方仍要在线履约和监控，RPC 仍需可用。链上发布报价与数据有成本，也不提供隐私；不应将本地免费执行当成公共链商业成本。
