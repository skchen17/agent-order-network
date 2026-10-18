import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, cp, writeFile } from "node:fs/promises";
import { readJSON, saveJSON } from "../src/agent-runtime.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = path.resolve(process.argv[2] ?? ".local-demo/codex-live-001");
await mkdir(path.join(directory, "public-source"), { recursive: true });
// Public source snapshot excludes wallets, environment files and previous test evidence.
for (const item of ["README.md", "package.json", "src", "contracts", "docs", "test", "examples", "fixtures"]) {
  await cp(path.join(root, item), path.join(directory, "public-source", item), { recursive: true });
}
for (const role of ["buyer", "seller"]) {
  await mkdir(path.join(directory, role), { recursive: true });
  await cp(path.join(root, "skills/p2p-orders"), path.join(directory, role, "skill"), { recursive: true });
  // Source wrapper fallback is repo-relative, so use an explicit absolute wrapper for this source-only trial.
  await writeFile(path.join(directory, role, "skill/scripts/orders.mjs"),
    `import { runAgentTool } from ${JSON.stringify(new URL("../src/agent-tools.mjs", import.meta.url).href)};\nprocess.exitCode = await runAgentTool();\n`);
}
const common = role => `你是一个真实的独立 Codex CLI 会话，参与本地订单协议试跑，角色为${role === "buyer" ? "需求方" : "供应方"}。\n` +
  `必须先读取你的 Skill：${path.join(directory, role, "skill/SKILL.md")}，按需读取同目录 references/protocol.md，再调用配套脚本。不要生成另一套Agent应用或调用本地模型；你自己理解需求。\n` +
  `你的工作目录：${path.join(directory, role)}。所有你产生的文件只写在这里；不要修改项目源码或Skill。\n` +
  `公共部署描述：${path.join(directory, "network/deployment.json")}。你的签名配置：${path.join(directory, "network", role, "config.json")}，仅将路径传给工具，不要读取、打印或复制私钥文件。\n` +
  `其他会话的工作目录和签名配置不得读取。不能向其他Agent发送消息；双方交易信息只能从链上订单、报价、交付获得。不要启动子Agent。\n` +
  `项目公开源码快照在${path.join(directory, "public-source")}，只允许在此读取履约依据；禁止读取 .env、用户配置、其他运行目录或环境变量。源码快照没有 scripts 目录，不能声称据此复现完整测试。\n` +
  `这是31337本地测试链，不能访问公共链或真实钱包。已有请求只授权明确说明的测试动作，不能将任何approval摘要当成人类确认。记录每个协议调用的输入和输出（不含密钥），不要无止境轮询。发现缺口在自己目录写 observations.md。\n`;
const sourceText = "请帮我检查这个项目是否已经能让现成的 Agent 只靠配套 Skill 完成直接交易。我要中文 Markdown 报告，至少列出5个具体发现，每项有公开源码文件和关键函数依据，区分已实现、缺口和未验证，再给3条能复现检查的命令。不重写代码、不装软件、不注册账号、不接真实资金，不把脚本模拟称为独立Agent实测；无法验证的明确写未验证。履约只读取提供的公开源码快照，不读取密钥、环境变量或其他运行目录。现有合约做不到的条件要明确指出。预算上限2 TESTUSD，仅本地测试款；发布后1小时内选择供应方，24小时内交付，提交后我有24小时人工检查，有争议最多等待24小时裁定。";
await writeFile(path.join(directory, "buyer/initial-prompt.txt"), common("buyer") +
  `\n用户自然语言需求如下：\n${sourceText}\n\n请独立理解、生成复杂terms、调用draft_order和validate_order。若有实质歧义先报告，不要自行编造。你已获授权发布这笔符合上述范围的本地测试需求，可准备并执行publish。发布后停止：不得选报价、锁款或确认交付，这些需要用户之后的具体确认。\n` +
  `最终报告发布的订单编号、草稿文件、链上条款和你发现的接入问题。保存 buyer-state.json，包含orderId、draft文件及后续恢复说明。\n`);
await writeFile(path.join(directory, "seller/initial-prompt.txt"), common("seller") +
  `\n你代表一名能做 Node.js/Solidity 静态代码检查、中文技术文档与开源项目接入分析的供应方。不提供视频/图形UI制作，不注册账号、不安装软件、不付真实资产。你可以在4小时内交付一份小型Markdown检查报告，报价1.5 TESTUSD。\n` +
  `请从公共部署开始独立发现公开可接单需求，完整分页，对比候选并说明为什么合适或不合适。不要只依赖精确技能标签；你没有预先得到目标订单编号或需求正文。\n` +
  `已有授权：可对一笔符合上述能力、预算与限制的本地测试订单发布1.5 TESTUSD报价，承诺从报价起4小时内交付。报价后先停止，不在看到Funded前履约，不要提取或转移任何资金。\n` +
  `保存 seller-state.json，包含选择的orderId、匹配解释、报价信息和恢复说明；最终报告候选比较、报价结果和接入问题。\n`);
await saveJSON(path.join(directory, "trial.json"), { directory, startedAt: new Date().toISOString(), sourceText,
  sessions: {}, limitations: ["same machine and account", "instruction-based role/file separation, not OS isolation", "real Codex CLI threads, not prerecorded model outputs"] });
console.log(JSON.stringify({ directory, buyerPrompt: path.join(directory, "buyer/initial-prompt.txt"), sellerPrompt: path.join(directory, "seller/initial-prompt.txt") }));
