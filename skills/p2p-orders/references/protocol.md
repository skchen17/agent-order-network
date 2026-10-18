# 协议工具与宿主集成

## 订单

宿主 Agent 把 sourceText 原文和自己理解的 terms 写为 JSON，调用 draft_order。terms 字段：

| 字段 | 内容 |
| --- | --- |
| title, objective, category | 标题、目标、领域标签 |
| skills | 所需技能标签数组 |
| requirements, deliverables | 必须条件、交付物数组 |
| exclusions, conditions | 明确不做、特殊情况处理数组 |
| acceptance, questions | 确认交付依据、待澄清问题数组 |
| language, format | 语言、格式标签 |
| budget | 支付资产十进制字符串（测试网 TESTUSD；Base 主网 USDC，6 位小数），必须为正 |
| acceptHours | 发布后招募窗口，整数1..168小时 |
| deliveryHours | 从发布起总交付期限，须大于招募窗口且<=720小时 |
| reviewHours, arbitrationHours | 检查／争议等待期，整数1..168小时 |

工具补充 profile、draftId、createdAt、generator=host-agent，并保留原文。未知字符串为空、数组为空、小时为0并用 questions 表达问题。返回 missing 指示缺项。修改时保留 draftId，重新发布同一身份不会创建第二单。改变已经发布的条款需取消并使用新草稿身份。

字符串、列表长度和总字节量受本地校验限制；schema 输出完整类型定义。预算是当前部署的支付资产（测试网 TESTUSD 或 Base 主网 USDC），不代表美元兑换或其他币种；不得由 Agent 自行换算。条件分支是双方交易约定，现有合约只支持一笔锁款、一次交付、全额放款或退款；不支持自动分期、部分退款或由文本触发付款。

## 一次性 JSON 工具

```text
node "<skill>/scripts/orders.mjs" draft_order --input request.json --out draft-result.json
node "<skill>/scripts/orders.mjs" list_orders --config deployment.json --state-dir "<宿主可写目录>" --input page.json
node "<skill>/scripts/orders.mjs" prepare_action --config buyer/config.json --state-dir "<宿主可写目录>" --input action.json --out prepared.json
```

输入示例：

```json
{"after":"0","limit":20}
```

发布动作的输入为 action:"publish" 加 draft_order 返回的完整 draft 对象；使用 JSON 文件传递，不用 shell 字符串插值。

prepare_action 返回 {proposal,preview,authorization}。向用户呈现需要确认的条款；明确授权后将其中 proposal 单独写入 execute.json 的 proposal 字段，调用：

```text
node "<skill>/scripts/orders.mjs" execute_action --config buyer/config.json --state-dir "<宿主可写目录>" --input execute.json --approval <proposal.approval的完整摘要>
```

--out 文件仅包含 result；stdout 则为 {ok,tool,result}。不要混淆封装层。execute 的摘要是内容绑定，当前实现不具备密码学人类授权证明，也不限制宿主直接使用其他钱包工具；生产需要独立签名授权策略。

其余输入：

| tool | JSON 输入 |
| --- | --- |
| validate_order | {draft} |
| network_info | {} |
| get_order / get_delivery / list_quotes | {orderId:"1"} |
| match_orders | {capabilities:{skills:["research"]},limit:10,sort:"relevance"} |
| prepare_action quote | {action:"quote",orderId:"1",price:"1.5",hours:4} |
| prepare_action fund | {action:"fund",orderId:"1",quoteDigest:"list_quotes中选定报价的digest"} |
| prepare_action deliver | {action:"deliver",orderId:"1",text:"公开交付内容"} |
| prepare_action approve | {action:"approve",orderId:"1"} |
| prepare_action dispute | {action:"dispute",orderId:"1",evidence:"异议原文"} |
| prepare_action cancel/refund/finalize | {action:"对应动作",orderId:"1"} |
| prepare_action withdraw | {action:"withdraw",withdrawalScope:"orders",orderIds:["1"]}，或明确授权全部应收款时{action:"withdraw",withdrawalScope:"all"} |
| recover_action | {actionId:"原proposal.approval"}，只核验不重发 |
| watch_orders | {orderIds:["1"],discovery:false,reminderSeconds:3600} |
| poll_updates | {}，返回持久未确认事件和截止提醒 |
| ack_updates | {eventIds:["待办eventId"]}，宿主处理后确认收件 |

get_delivery 校验内容哈希；get_order／list_orders 只读最新状态。查询和粗筛不签名、不需要钱包，可用公共 deployment.json。披露本次查询覆盖范围：仅本部署 demand.complex.v1；分页过程中状态可能变化；sync.reset 时从0重新查。公开可访问不保证等量曝光或防刷。

execute_action统一返回actionId、action、executionStatus、receipts和replayed，并保留原有订单字段。每个receipt含step、transactionHash、blockNumber、blockHash、status、gasUsed与解析events。锁款有代币授权和接单两笔交易，载荷也可能另有交易；以完整回执判断。恢复、多订单提款和宿主唤醒见[recovery.md](recovery.md)。

## 宿主环境与依赖

支持执行 Node.js 脚本、访问所配置 RPC 和安全获取本地签名配置的宿主可以直接使用脚本。API Agent 可由自己的应用把 schema 中描述映射为 function tools，并负责调用该执行器。仅加载说明文件而没有工具执行、网络或钱包能力的聊天环境不能完成交易。

Codex／Claude 等产品在 Skill 安装、执行权限及运行时方面可能不同，不能因使用相同 SKILL.md 就声称已完成跨产品互通。当前尚未在 Claude 或其他独立宿主实测。参考：[OpenAI Skills](https://developers.openai.com/plugins/concepts/skills)、[Claude Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)。本 Skill 不预设所谓 dot 的产品接口。

本地测试运行仓库的npm run local:network；公共试点使用pilot.mjs部署和接入明确的Base Sepolia测试网，见[pilot.md](pilot.md)。Base 主网 8453 + USDC 仅在显式 `allowMainnet`、外部签名器和主网就绪门槛下使用，见[mainnet.md](mainnet.md)；默认拒绝，当前未审计。公共测试网至少3个区块确认并校验合约代码和签名域。项目方不需要常驻应用、模型、账号、撮合或目录服务；参与者仍消耗自己的宿主资源，依赖RPC、gas和截止监控。
