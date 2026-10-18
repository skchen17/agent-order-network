# 现有 Agent 的 Skill 接入

产品是公开订单协议与宿主配套 Skill。Codex、Claude 或 API Agent 自己理解用户、编写和比较复杂需求并履约；项目不再要求自有应用、Ollama 或用户手动操作 CLI。Node 脚本是宿主调用的执行器，一次调用后退出。

## 仓库内使用

安装 Node.js 24+，执行 npm.cmd ci。让宿主加载 skills/p2p-orders/SKILL.md，并提供可执行环境与配置文件路径。获取工具描述：

```powershell
node skills/p2p-orders/scripts/orders.mjs schema
```

宿主把自己理解的需求写成 JSON，draft_order 只负责组装与校验。list_orders 返回公开需求全文供其判断复杂语义；match_orders 为可选粗筛。通过 prepare_action 查看精确动作，再根据用户在原对话的真实授权使用 execute_action。不要让用户自己准备协议 JSON；这是 Agent 的工作。

公开发现只需要无私钥 deployment.json。测试链可由开发者运行：

```powershell
npm.cmd run local:network -- --out .local-demo/skill-001
```

本地演示分别使用自己的buyer/config.json或seller/config.json，公开读取使用deployment.json。配置里为随机开发密钥，不要上传、粘贴进聊天或打包。跨设备试点使用Base Sepolia公开部署清单，各自join生成自己的新钱包；不复制对方config，不将localhost当作另一台设备的链入口。

为每个钱包选择自己可写的持久状态目录，调用链上工具时传 --state-dir <目录>。公开读取也会写本地索引；v0.5默认改为当前工作目录内按部署和钱包隔离的.agent-tools子目录，并在联网前检查可写性。交易、恢复及唤醒必须使用同一目录。它是运行时命令行选项，不是工具 JSON 参数。

## 可分发 Skill 包

```powershell
npm.cmd run package:skill
```

输出到新的 .local-demo/skill-packages/目录。包内有 SKILL.md、references/、scripts/ 下 orders、wake、pilot、codex-wake 四个入口和 runtime（SDK源码、合约产物、package.json及锁文件），不会复制钱包、运行记录、node_modules 或项目测试数据。可用 --out 指定一个不存在的输出目录；已有内容不覆盖。

将整个 p2p-orders 文件夹放到目标宿主支持的 Skill 位置。根据宿主的安装方式安装依赖：

```powershell
npm.cmd --prefix "<skill目录>/runtime" ci --omit=dev
node "<skill目录>/scripts/orders.mjs" schema
```

Skill 说明和脚本无需读取宿主的模型 API Key；用户已使用的 Agent 和模型照常工作，token／执行资源由其原环境承担。不同宿主的 Skill 路径、联网、脚本及签名权限不同。本项目只交付协议工具，不声称同一 Markdown 在所有产品中都能直接交易。

参考：[OpenAI Skills](https://developers.openai.com/plugins/concepts/skills)、[Claude Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)。这些文档支持说明与脚本打包的形态，不证明本项目已经完成产品间兼容测试。用户提及的 dot 不预设特定 API 或安装接口。

## API 宿主

schema 返回工具名称、描述和参数。自己的 API 应用可将其映射为 function tools；应用执行相应 Node 脚本并把 JSON 结果返回给 Agent。当前提供通用描述，不提供某家 API 的 SDK、严格 schema 转换或托管签名服务；按所用 API 的工具格式适配即可。只有文本补全能力、没有执行器和钱包授权的环境，无法仅靠 Skill 文本交易。

stdout 为单个 {ok,tool,result} 或 {ok:false,error}，失败退出1。--input file 或 - 接收JSON，--out 只保存 result。prepare_action 输出含 proposal 的封装对象；execute_action 的输入必须是 {proposal:...}。不要把 proposal.approval 当成人类已确认；它只是内容摘要。已有授权覆盖动作时无需重复问，超出时在原对话确认。

## v0.5：回执、恢复和唤醒

execute_action保存持久动作日志并统一返回actionId和receipts，包含每一步交易哈希、规范区块哈希、gas及事件。同一成功提案再次调用只核验已有回执，不重发；断线用recover_action查询原actionId、当前订单及钱包/credits/allowance。未决广播保留钱包写入锁；只完成代币授权时恢复不会擅自补发锁款。保持同一钱包单写入者，不通过换状态目录绕过锁。

提款必须明确withdrawalScope:"orders"加orderIds，或用户授权全部应收款时指定"all"。新合约按订单记应收额；指定订单提款不包含其他新到账订单，全部提款在合约内同时检查金额及应收款版本。旧的本地部署需重新部署，已有合约不会被升级。

watch_orders登记订单／新需求及提醒窗口；poll_updates补扫离线事件并返回持久待办，处理后ack_updates。成功交易自动登记对应订单。参与者用自己的定时器调用Skill中的scripts/wake.mjs，有待办才通过本地adapter命令恢复宿主；失败／超时不确认待办，下次重试，输出日志保存在自己的状态目录。脚本每轮退出，不依赖项目方服务器；本机休眠或关机时不会主动执行。

完整输入、投递去重、人工确认和限制见[恢复与唤醒说明](../skills/p2p-orders/references/recovery.md)。v0.6已用新真实Codex会话验证接入及恢复原会话读链，资金未动；未自动安装系统定时任务，其他宿主及实际跨设备仍未验证。

## v0.6：外部参与者和公共测试网

使用[首次接入指南](../skills/p2p-orders/references/pilot.md)及[试点执行流程](pilot-runbook.md)。pilot脚本负责prepare、join、doctor、deploy、claim、bind-codex、status及export-evidence。新钱包从本机生成，工具不把私钥读入模型；公开邀请只包含部署信息和指纹，不包含钱包、私有RPC令牌或宿主认证。

公共网络限定Base Sepolia 84532和无价值TESTUSD；每单默认上限2 TESTUSD，领取支付测试币直接调用测试合约，不依赖发起者发币服务器。各方仍需从外部官方列示水龙头领取自己的测试gas。部署检查使用构建运行时代码、不可变字段掩码、代码哈希及签名域；RPC可换，部署指纹不变。

Codex适配器只恢复明确绑定的会话，要求turn.completed、准确的全部eventIds和持久收件记录后才确认待办；exit0本身不足。只读唤醒不会交易，attention由用户自己的Agent呈现。导出的调度命令由参与者接入自己的定时器，没有项目方调度服务。当前公共RPC只读验证通过，实际公共部署等待测试gas，真实跨设备交易也待验收。

## 已验证和后续

npm run demo:skill 用独立一次性工具进程完成：宿主结构化草稿、公开两单分页发现、报价、授权缺失拒绝、准备不付款、锁款、读取交付、确认和提款。测试不运行交互客户端或本地模型；宿主理解、授权和交付内容均为测试夹具，不代表真实 Codex／Claude 互通或自主研究质量。

另一次[两个真实 Codex 会话试跑](codex-live-trial.md)已完成自然语言需求、复杂订单生成、分页语义筛选、用户确认锁款、实际交付、第二次用户确认及供应方提款。两端为本机独立持久会话，共用协议 SDK；不是跨设备、跨产品或海量订单测试。

项目方无需长期运营撮合、目录、账户、文件或模型服务器。参与者仍需自己的宿主执行环境、RPC、钱包和截止监控；本地开发链运行期间需要节点进程。生产会话签名隔离、公共测试网、争议公平性和规模检索仍是后续工作。现有合约的无异议付款与仲裁超时退款规则保持有效。
