# 回执、恢复与参与者自己的唤醒

## 持久目录和交易回执

为每个钱包选择一个自己的可写目录；所有工具、恢复和定时检查共享同一--state-dir。保留其中的SQLite文件及WAL文件，备份时停止写入或使用SQLite备份方式，不能仅复制正在写入的单个主文件。缓存可重建，未决动作记录不能当缓存删除。钱包配置另行保管，不向模型展示密钥。

execute_action成功保留原有orderId/order/status等字段，另外统一返回：

```json
{"actionId":"0x完整摘要","action":"fund","executionStatus":"completed","receipts":[{"step":"approve_token","transactionHash":"0x...","blockNumber":14,"blockHash":"0x...","status":1,"gasUsed":"...","events":[]},{"step":"accept_quote","transactionHash":"0x...","blockNumber":15,"blockHash":"0x...","status":1,"gasUsed":"...","events":[]}],"replayed":false}
```

发布或交付可能先写公开载荷，因此会有多个回执。events是已识别合约地址发出的解析事件，不把无关地址同名事件算作协议证明。确认订单完成与钱包实际到账是两步；提款返回walletBalance和remainingCredits，并提供Withdrawn/Transfer事件。

工具错误可能携带error.execution，含actionId、已知步骤和回执。若进程未输出，actionId仍等于调用前保存的proposal.approval。恢复输入：

```json
{"actionId":"0x原提案的完整摘要"}
```

调用recover_action；工具不会签名、付款或撤销授权：

- completed：最终交易已在当前规范链上确认；返回回执、当前订单及余额。原成功提案可幂等读取，不需要重新付款。
- interrupted：已知步骤终结，但最终交易未完成。例如仅代币授权已确认。先核验订单及allowance，再在真实授权范围内准备新提案；恢复不会自动补发或撤销授权。
- uncertain：广播结果仍未知、回执消失或区块哈希变化；保留记录，稍后再查，本地钱包写入继续阻断。不得换目录、清空记录或换身份重发。

广播返回后立即保存哈希；广播前保存发送方nonce和精确calldata。若断线刚好发生在两者之间，恢复最多扫描2000个区块寻找匹配交易。超出范围或交易仍未知时保持uncertain，不以“暂时查不到”推断没付款。记录中的原交易执行者尚未退出时拒绝并发恢复。

同一钱包跨多个目录／不同SDK的并发写入无法由本地锁共同约束；当前仍要求单写入者。恢复不替代公共链确认深度或生产签名策略。

## 指定提款范围

```json
{"action":"withdraw","withdrawalScope":"orders","orderIds":["3","7"]}
```

prepare_action列出每单应收款、合计及钱包全部应收款；合约withdrawOrders只提取这些订单，即便别的订单同时到账也不会扩大范围。提款后各单应收额清零，不能重复提取。只有明确授权“全部应收款”时使用：

```json
{"action":"withdraw","withdrawalScope":"all"}
```

withdrawAll(expectedAmount,expectedVersion)在合约内核对总额和应收款变更版本；金额或组成变化就回滚，即使总额后来又相等也不能沿用原提案。旧withdraw()接口为底层兼容保留，Skill执行器不调用它。新功能需要新部署的v0.5合约，旧合约不可升级，不能把新ABI当作旧部署已具备新功能。

## 关注和待办

watch_orders输入示例：

```json
{"orderIds":["3","7"],"discovery":false,"reminderSeconds":3600}
```

供应方希望观察新订单时设discovery:true；它只提醒发现候选，语义判断仍由宿主读订单完成。poll_updates输入{}，补扫游标后所有相关事件，并返回最多100条未确认待办、hasMore和nextPollAt。读取后进程退出也不会丢待办；处理完成后ack_updates输入{"eventIds":["0x待办ID"]}，继续读取其余页。

将近和已过期限分别提醒。提醒使用本机时间与链时间较大值，避免无新区块时漏报；真正能否退款或结算仍以合约时间为准。提醒不自动批准、争议、退款或提款。重组时按锚点哈希重建并返回reset；宿主应重新读取链上状态，不使用旧待办当最终事实。

## 一次检查后退出

```text
node "<skill>/scripts/wake.mjs" --config "<自己的角色配置>" --state-dir "<同一持久目录>"
```

不带adapter只检查并输出JSON，不消费待办。想恢复自己的宿主，提供本地adapter.json：

```json
{"command":"宿主可执行文件的绝对路径","args":["参数1","参数2"],"cwd":"宿主工作目录的绝对路径"}
```

```text
node "<skill>/scripts/wake.mjs" --config "<配置>" --state-dir "<同一目录>" --adapter "<adapter.json>" --timeout-seconds 300
```

脚本将p2p-orders-wake.v1 JSON通过stdin交给宿主命令，不使用shell，不从链上取可执行命令。宿主须持久接收eventIds、保留用户确认边界后才退出0；非零、超时或启动失败都不确认待办。stdout/stderr保存在state-dir/wake-runs内，返回hostOutput路径供原交互环境展示，不把可能含敏感信息的宿主日志嵌入公共结果。成功接收只代表宿主收件，不代表它已完成交易或取得用户同意。

使用自己的Windows任务计划、cron或宿主已有定时能力每分钟调用一次；命令每轮退出，无需常驻项目服务。机器需能运行任务并连接RPC，休眠／关机时不会执行；应让自己的调度器恢复后补跑并定期检查任务失败。这里不自动注册系统任务、不创建项目方调度账户。

调度及宿主接收为至少一次投递：宿主收到后、确认写回前若崩溃，下次可能再次收到相同eventIds。宿主应据ID去重；每笔资金动作仍使用动作日志，不能把重复提醒变成重复付款。保留原会话已经表达的授权范围；自动提醒不授权新交易。

## Codex CLI 会话示例

已有Codex CLI会话可通过本地配置把事件送回其明确的会话ID：

```json
{"command":"Codex可执行文件的绝对路径","args":["exec","resume","--json","明确的SESSION_ID","-"],"cwd":"原会话工作目录的绝对路径"}
```

参数以本机codex exec resume --help为准；参与者工作目录不在Git内时需由操作者评估后显式增加--skip-git-repo-check。使用原宿主认证和权限，不在adapter中复制密钥、绕过沙箱或猜测会话ID。输出保存在hostOutput所指本地日志；这不会自动把内容展示到Codex桌面聊天中。不要让用户正在使用的同一会话同时接受多个执行者。

已核对[OpenAI非交互模式文档](https://learn.chatgpt.com/docs/non-interactive-mode)和本机CLI帮助。v0.6的pilot bind-codex生成严格适配器：在新真实会话中完成接入，退出后由事件恢复同一会话并读取当前订单，再核对完整事件ID并持久化收件记录，资金未动。通用入口仍支持其他宿主命令；Claude或其他产品未实测。公共试点恢复需满足配置的确认深度，详见[pilot.md](pilot.md)。
