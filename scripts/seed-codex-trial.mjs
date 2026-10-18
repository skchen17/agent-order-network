// Clearly labelled fixture distractors; the target demand is written by the real buyer Codex session.
import path from "node:path";
import { callAgentTool } from "../src/agent-tools.mjs";
import { saveJSON } from "../src/agent-runtime.mjs";
const directory = path.resolve(process.argv[2]);
const configFile = path.join(directory, "network/buyer/config.json");
const common = { objective: "测试用公开干扰需求，不代表真实商业订单", requirements: ["按约交付"], deliverables: ["完整成果"],
  exclusions: [], conditions: [], acceptance: ["买方人工确认"], questions: [], acceptHours: 1, deliveryHours: 24, reviewHours: 24, arbitrationHours: 24, language: "zh" };
const fixtures = [
  { ...common, title: "制作30秒门店宣传视频", category: "video", skills: ["video-production"], format: "mp4", budget: "100", requirements: ["需要实拍与视频剪辑，不接受文字报告"] },
  { ...common, title: "开通付费数据账号并撰写市场报告", category: "research", skills: ["market-research"], format: "markdown", budget: "50", requirements: ["必须自行注册第三方账号并先垫付订阅费"] }
];
const records = [];
for (const terms of fixtures) {
  const { draft } = await callAgentTool("draft_order", { sourceText: `${terms.title}；这是独立会话筛选试验的干扰项。`, terms });
  const { proposal } = await callAgentTool("prepare_action", { action: "publish", draft }, { configFile });
  const result = await callAgentTool("execute_action", { proposal }, { configFile, approval: proposal.approval });
  records.push({ orderId: result.orderId, title: terms.title, fixture: true });
}
await saveJSON(path.join(directory, "fixture-orders.json"), records);
console.log(JSON.stringify(records));
