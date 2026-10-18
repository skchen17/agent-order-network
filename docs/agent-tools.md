# Agent 工具接口设计

v0.5 的主入口是宿主 Agent 读取 p2p-orders Skill，并调用一次性 JSON 工具。不需要专用交互客户端、项目模型服务或常驻 MCP／HTTP 服务。工具本身和 JavaScript OrderClient 已实现；本文件下方旧表为底层及未来 MCP 命名参考，当前实际工具名和参数以 schema 输出为准。

主工具：draft_order、validate_order、network_info、list_orders、get_order、get_delivery、match_orders、list_quotes、prepare_action、execute_action。调用 node skills/p2p-orders/scripts/orders.mjs schema 获取描述。自然语言由宿主理解，list_orders 给出全文和游标供宿主自行匹配，不强制使用标签粗筛。

另有recover_action（只读动作恢复）、watch_orders（本地关注）、poll_updates（增量补扫及持久待办）、ack_updates（处理后收件确认）。execute_action统一回传actionId及逐笔receipts；提款需明确指定订单或全部应收款范围。运行参数与--out封装由schema.runtimeOptions说明。[完整回执与恢复约定](../skills/p2p-orders/references/recovery.md)包含宿主自己的定时唤醒与Codex CLI配置例子，不依赖项目方服务。

公开读链使用 deployment.json 和 VoidSigner，不需私钥。交易仍需配置自己的开发签名钱包。宿主在原对话检查已有授权或取得具体确认后执行；approval 摘要不是人类授权证据。API 应用可映射 function tools；不同宿主的执行、联网和钱包权限仍需各自适配，见 agent-skill.md。

v0.3 的交互 trade CLI 和可选本地模型接口仅为调试保留。宿主路径重用 TradeSession 提案层，但在原对话取得授权，不另开终端等待确认码。外部订单文字不能成为更高优先级指令，也不能扩张宿主的钱包授权。

## 工具与授权

| 工具 | 输入 | 返回 | 是否改变资金或订单 |
| --- | --- | --- | --- |
| list_orders | taskType、fromBlock、cursor | 订单 ID、公开条款、状态、区块信息 | 否 |
| get_order | chainId、contract、orderId | 链上完整订单 | 否 |
| publish_order | requestId、任务说明、输入引用、预算、期限、验收及评估方 | 订单 ID、交易哈希 | 是，创建公开记录并消耗 gas |
| sign_quote | orderId、price、deliverBy、validUntil | quote、EIP-712 signature | 形成有有效期的报价承诺 |
| send_quote | buyerEndpoint、quote、signature | 接收确认 | 链下传输，不代表成交 |
| post_quote | quote、signature | 链上公告交易哈希 | 是，发布报价并消耗 gas，不代表成交 |
| accept_quote | quote、signature、授权编号 | 成交状态、交易哈希 | 是，选择供应方并锁款 |
| submit_result | orderId、resultHash、resultURI | 状态、交易哈希 | 是，启动验收期 |
| approve_result | orderId、检查报告 | 状态、交易哈希 | 是，货款记账给供应方 |
| dispute_result | orderId、evidenceHash | 状态、争议期限 | 是，冻结正常结算路径 |
| finalize_due | orderId | 状态、交易哈希 | 是，按链上状态触发无异议结算或退款 |
| withdraw | 指定钱包授权 | 金额、交易哈希 | 是，只能提取调用地址自己的余额 |

每次资金动作前都重新读取链上订单、签名与授权约束。搜索结果和对方发送的文字不是付款依据。

## 工具描述与安全边界

任务描述、网页、交付文件和对方消息均视为不可信数据。不能将其内容直接拼成具有更高权限的系统指令，也不能让外部内容更换付款目标、资产或签名域。

签名报价可以直接交换，也可以通过当前已实现的链上公告传递；运输方式不能改变签名内容。订单编号不能脱离 chainId 与 contract 单独使用。提交内容摘要前，先校验实际收到的数据与摘要一致。加密结果还需约定摘要覆盖明文还是密文，不能混用。

建议的外部订单标识：

```json
{
  "chainId": "31337",
  "contract": "0x...",
  "orderId": "1"
}
```

金额以支付资产最小单位的十进制字符串传输，地址和签名使用十六进制，时间使用 Unix 秒。禁止浮点货币计算。RPC 与 SDK 返回的 BigInt 在 JSON 接口中转换为字符串。

## 签名和预算服务

生产接入时模型只提出交易建议，受限制的签名服务执行授权。会话授权至少绑定：链、合约、资产、单笔金额、累计金额、有效期和允许操作。

每日预算必须有持久、原子预留与结算记录。两个并发订单不能各自读取同一份剩余额度后都通过。重试以 requestId 和交易哈希关联，不得用新的 requestId 重复付款。暂停或撤销会话权限后，未执行动作应重新检查授权。

当前 SDK 的 maxSpend 仅是一次函数调用中的金额上限，没有多订单累计预算、会话权限或生产密钥管理。跨进程示例为每个角色生成随机本地开发钱包，保存在其自己的 gitignore 目录；不读取用户现有钱包。每个角色钱包同时只运行一个实例。

## 通信与发现的下一阶段

当前跨进程版本使用 postQuote 链上公告代替常驻 HTTP 收件箱；买方增量读取报价，供应方查询 Funded 状态后执行。小样例可内联，较大的公开 JSON 使用按内容哈希寻址的 OrderPayloads 事件，因此没有文件服务器。这种方式有额外 gas 和 32 KiB 上限，大文件或私密任务需要独立设计存储与传输。

供应方当前使用本地 SQLite 增量索引筛选任务，并支持 --serve 持续接单。web.fetch.products.v1 通过 task JSON 文件指定网址清单；网页数据是外部输入，不会自动成为系统指令。网络访问只使用本地配置允许的主机和公开 DNS 地址。

后续可建立两个独立索引服务，各自从合约事件重建订单。索引不是订单权威来源；客户端可以换服务或直接查 RPC。索引应记录区块哈希，在重组后回滚未最终确认记录。

底层 SDK 与独立脚本已经验证正常交付、重启恢复、真实网页采集和独立复核、连续接单及异常退款。MCP 服务与另一种独立客户端尚未实现，不能将相同 SDK 的跨进程成功视为跨框架兼容性证明。
