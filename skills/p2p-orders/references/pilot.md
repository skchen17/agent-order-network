# 陌生参与者接入与跨设备测试网试点

当前公共试点只开放Base Sepolia（84532）；TESTUSD是无价值、无美元兑付关系的测试资产。主网禁用，每单默认上限2 TESTUSD。公开链上全部订单和交付均公开；试点只用可公开的小型文档、资料整理和源码检查任务。

## 参与者由自己的Agent接入

用户只需提供本Skill目录、公开deployment.json、邀请指纹及自己的买方／供应方意向。先核对指纹来自所选邀请者；它绑定网络、合约、支付资产、载荷、评估方及构建代码，不包含可由参与者替换的RPC地址。不同设备均连接同一公开链，不共享localhost，不复制钱包或状态目录。

```text
node "<skill>/scripts/pilot.mjs" join --deployment "<公开清单>" --fingerprint "<邀请指纹>" --role seller --out "<不存在的新参与者目录>"
node "<skill>/scripts/pilot.mjs" doctor --config "<参与者目录>/config.json" --state-dir "<参与者目录>/state"
```

join验证部署、生成自己独有的新钱包并保存participant.json。清单有私钥等额外字段时不会继承。目录已存在则停止，不能覆盖；重启后继续使用原participant.json。可以用--rpc指定自己的HTTPS测试网RPC，链和代码仍会校验。

由Agent解释doctor的失败项。若缺gas，向用户展示本次新钱包的公开地址及[Base官方测试资金指引](https://docs.base.org/get-started/get-funds)；外部水龙头可能要求用户自己验证，不替用户注册或购买资产。买方有测试gas后可调用：

```text
node "<skill>/scripts/pilot.mjs" claim --config "<自己的config.json>" --state-dir "<同一state目录>"
```

链上测试支付资产每地址可领取一次100 TESTUSD，领取消耗该用户的测试gas，无项目方发币服务器。只领取到自己的测试钱包，不是业务代币发行。仍需双方真实授权订单和付款。

## 绑定真实Codex会话和提醒

会话ID由当前宿主、CLI启动回执或用户明确提供；不要猜ID或使用--last，避免唤醒其他任务。Codex可执行文件使用本机绝对路径。让用户知道检查会消耗其原宿主推理资源。

```text
node "<skill>/scripts/pilot.mjs" bind-codex --participant "<participant.json>" --session "<原会话UUID>" --codex "<可执行文件绝对路径>"
```

非Git工作目录只有操作者确认其可执行时才添加--allow-non-git。生成codex-binding.json、wake-adapter.json、wake-schedule.json；不会自行注册系统任务。按返回命令执行一次wake，核对同一会话完成、事件ID准确、当前订单已读取、资金未动，再按参与者允许的方式将命令接到自己的调度器。只读唤醒只负责读取、解释及提请用户决定，不会替用户成交。

```text
node "<skill>/scripts/pilot.mjs" status --participant "<participant.json>"
```

status返回预检和attention：summary为最近一次真实唤醒的摘要，requiresUserAction提示用户是否需要决定。宿主应在自己的交互界面呈现；CLI恢复不会自动在桌面聊天里弹出消息。定时器未安装、机器休眠／离线时不能主动唤醒，链上期限继续；恢复后补扫待办。完整恢复及至少一次投递去重见[recovery.md](recovery.md)。

## 一次性部署者流程

```text
node "<skill>/scripts/pilot.mjs" prepare --out "<新的试点目录>"
node "<skill>/scripts/pilot.mjs" doctor --config "<试点目录>/deployer-wallet.json" --state-dir "<试点目录>/deployer-state"
node "<skill>/scripts/pilot.mjs" deploy --wallet "<试点目录>/deployer-wallet.json" --out "<试点目录>/public"
```

prepare仅生成新的专用测试身份，不发送交易；缺测试gas时deploy会报告needs-test-gas。部署固定测试币、订单和载荷合约，保存每笔交易日志；再次运行先恢复检查，不自动重复部署。部署途中不换钱包、目录、构建版本或并行使用部署钱包。

只分发public/deployment.json及其fingerprint与匹配Skill构建。deployer/evaluator钱包、deployment.actions.sqlite、participant钱包、会话日志和调度绑定均不分发。部署完成后无需部署者节点、API、账户、索引或调度服务器；参与者仍依赖自己的宿主、RPC、gas和定时检查。

评估方不会自动裁定。试点双方必须接受已披露的无异议结算与争议超时退款规则；不要把新生成的评估地址宣传为已有人值守的仲裁服务。
