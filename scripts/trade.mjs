import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import path from "node:path";
import { readJSON, saveJSON, json, connectAgent } from "../src/agent-runtime.mjs";
import { createDraft, generateDraft, validateDraft } from "../src/demand.mjs";
import { TradeSession } from "../src/trade-session.mjs";
import { demandView, orderView, proposalView, matchesView } from "../src/trade-view.mjs";

const { values } = parseArgs({ options: {
  config: { type: "string" }, model: { type: "string" },
  "model-origin": { type: "string", default: "http://127.0.0.1:11434" }
} });
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
const lines = rl[Symbol.asyncIterator]();
async function ask(prompt, fallback = "") {
  console.log(`${prompt}${fallback ? ` [回车保留：${fallback}]` : ""}`);
  const next = await lines.next();
  if (next.done) throw new Error("INPUT_CLOSED");
  return next.value.trim() || fallback;
}
const list = text => text.split(/[；;\n]/).map(x => x.trim()).filter(Boolean);
const labels = { title: "订单标题", objective: "要达到什么目标", category: "领域标签（双方采用一致名称，例如 research）", skills: "需要哪些技能标签（例如 research; chinese）",
  requirements: "必须满足哪些要求", deliverables: "需要交付哪些东西", exclusions: "哪些内容明确不做", conditions: "特殊情况下如何处理（例如某来源不可用时列明原因）",
  acceptance: "你确认收货时依据哪些约定", language: "交付语言标签（例如 zh）", format: "交付格式标签（例如 markdown）",
  budget: "最高预算（本地测试款 TESTUSD 数字，例如 2）", acceptHours: "愿意等待供应方报价多久（小时）", deliveryHours: "从发布起最晚多久交付（小时，须大于报价窗口）",
  reviewHours: "提交后你有多久检查并提出异议（小时）", arbitrationHours: "发生争议后等待约定评估方多久（小时）" };
const arrays = new Set(["skills", "requirements", "deliverables", "exclusions", "conditions", "acceptance"]);
const numbers = new Set(["acceptHours", "deliveryHours", "reviewHours", "arbitrationHours"]);
let agent;

async function editDraft(draft) {
  let fields = Object.entries(labels);
  if (draft.generator.startsWith("ollama:")) {
    console.log("本地模型生成的完整建议：\n" + demandView(draft));
    const all = await ask("输入 all 逐项编辑，回车只补缺项；发布前还会再次确认全部条款");
    if (all !== "all") {
      const missing = validateDraft(draft);
      fields = fields.filter(([key]) => missing.some(item => item.startsWith(key)));
    }
  }
  for (const [key, label] of fields) {
    const current = arrays.has(key) ? draft[key].join("；") : String(draft[key] || "");
    const answer = await ask(`${label}${arrays.has(key) ? "（多项用分号分隔，输入 - 清空）" : ""}`, current);
    draft[key] = arrays.has(key) ? answer === "-" ? [] : list(answer) : numbers.has(key) ? Number(answer) : answer;
  }
  const unanswered = [];
  for (const question of draft.questions) {
    const answer = await ask(`补充确认：${question}（留空则不能发布）`);
    if (answer) draft.requirements.push(`澄清：${question}；回答：${answer}`); else unanswered.push(question);
  }
  draft.questions = unanswered;
  validateDraft(draft);
  console.log("完整草稿。请检查是否忠实于你的原意：\n" + demandView(draft));
  console.log("仍需补充：" + (validateDraft(draft).join("、") || "无格式缺项；语义和现实可履约性由你确认"));
  return draft;
}

async function confirm(session, proposal) {
  const code = `确认 ${proposal.approval.slice(2, 14)}`;
  console.log(proposalView(proposal));
  console.log("提醒：订单和交付公开；验收期满无异议可付款，链不会替你判断复杂条件。开发评估方默认离线，仲裁超时退款买方。下列操作仅用于本地测试链。");
  let answer;
  do {
    answer = await ask(`如同意请输入「${code}」，其他输入取消；也可输入 详情 查看原始数据`);
    if (answer === "详情") console.log(json(proposal.ticket));
  } while (answer === "详情");
  if (answer !== code) { console.log("已取消，未执行此动作。"); return; }
  const result = await session.execute(proposal, proposal.approval);
  console.log("执行完成：\n" + (result.order ? orderView(result) : result.withdrawn ? `已提取自己的测试款，记录保存在本机。` : `订单 ${result.orderId} 的报价已公开。`));
  await saveJSON(path.join(path.dirname(values.config), "last-trade.json"), { kind: proposal.ticket.kind, approval: proposal.approval, result });
}

try {
  let session;
  if (values.config) {
    const config = await readJSON(values.config);
    if (!["buyer", "seller"].includes(config.role)) throw new Error("Choose a buyer or seller configuration");
    agent = await connectAgent(config.role, { config: values.config, state: path.join(path.dirname(values.config), "human-state.json") });
    session = new TradeSession(agent);
    console.log(`当前身份：${config.role === "buyer" ? "需求方" : "供应方"}；测试钱包：${config.address}`);
  }
  console.log("本地交易助手。需求和能力留在本机，明确确认发布后才上链。无项目方账户、目录服务器或中转服务器。");
  console.log(values.model ? `草稿模型：本机 Ollama ${values.model}。不会自动下载或改用云端。` : "当前为引导填写模式，不调用大模型；可用 --model 指定自己已安装的本地 Ollama 模型。");
  let running = true;
  while (running) {
    console.log("\n命令：new 新建需求 | edit 编辑草稿 | publish 发布 | match 找适合自己的订单 | quote 报价 | fund 挑选报价并确认交易 | deliver 提交交付 | review 查看并确认交付 | status 查看订单 | cancel 撤单 | refund 超时退款 | finalize 无异议结算 | withdraw 收款 | exit 退出");
    try {
      const entered = await ask("输入命令");
      const command = ({ 新建: "new", 编辑: "edit", 发布: "publish", 找订单: "match", 报价: "quote", 成交: "fund", 交付: "deliver", 验收: "review", 查看: "status", 撤单: "cancel", 退款: "refund", 结算: "finalize", 收款: "withdraw", 退出: "exit" })[entered] ?? entered;
      if (command === "exit") { running = false; continue; }
      if (["new", "edit"].includes(command)) {
        let draft;
        if (command === "edit") draft = await readJSON(await ask("草稿文件路径"));
        else {
          const source = await ask("用日常语言描述需求，包括你在意的限制和特殊情况（单行，最多4000字）");
          draft = values.model ? await generateDraft(source, { model: values.model, endpoint: values["model-origin"] })
            : createDraft(source, { title: source.slice(0, 40), objective: source.slice(0, 1000),
              requirements: list(source).filter(x => x.length <= 400), acceptHours: 1, deliveryHours: 24, reviewHours: 24, arbitrationHours: 24 });
          console.log("生成来源：" + draft.generator + "；以下逐项确认，期限为可修改的建议值。");
        }
        validateDraft(draft);
        await editDraft(draft);
        const file = await ask("保存草稿到", `.local-demo/drafts/${draft.draftId}.json`);
        await saveJSON(file, draft); console.log(`草稿已保存到 ${path.resolve(file)}；尚未发布或付款。`);
        continue;
      }
      if (!session) throw new Error("该操作需要 --config 指定自己的本地开发钱包；草稿功能无需钱包");
      if (command === "publish") {
        await confirm(session, await session.preparePublish(await readJSON(await ask("草稿文件路径"))));
      } else if (command === "match") {
        const file = await ask("自己的能力配置路径（留空交互填写）");
        const capabilities = file ? await readJSON(file) : {
          skills: list(await ask("我具备的技能标签（分号分隔）")), categories: list(await ask("领域标签（留空不限）")),
          languages: list(await ask("交付语言标签（留空不限）")), formats: list(await ask("交付格式标签（留空不限）")),
          minBudget: await ask("我的最低报价 TESTUSD", "0"), neededHours: Number(await ask("我至少需要多少小时完成", "1"))
        };
        const sort = await ask("排序方式 relevance 匹配度 / deadline 截止时间 / rotation 本地轮换", "relevance");
        const report = await session.match(capabilities, { sort });
        const reportFile = path.join(path.dirname(values.config), "match-report.json");
        await saveJSON(reportFile, report);
        console.log(matchesView(report)); console.log(`完整检索记录（含每笔排除原因）：${path.resolve(reportFile)}`);
      } else if (command === "quote") {
        const orderId = await ask("选择订单编号");
        console.log(orderView(await session.order(orderId)));
        await confirm(session, await session.prepareQuote(orderId, { price: await ask("报价 TESTUSD"), hours: Number(await ask("从现在起多少小时交付")) }));
      } else if (command === "fund") {
        const orderId = await ask("自己的订单编号"); const view = await session.quotes(orderId);
        console.log(orderView(view));
        view.quotes.forEach((q, index) => console.log(`报价 ${index + 1}：${q.amount} TESTUSD；供应方 ${q.quote.provider}；承诺交付 ${new Date(Number(q.quote.deliverBy) * 1000).toISOString()}；剩余有效期 ${q.remainingSeconds}秒`));
        if (!view.quotes.length) { console.log("暂无有效报价，稍后再查。"); continue; }
        const selected = Number(await ask("选择报价序号（从1开始；0取消）"));
        if (selected === 0) continue;
        if (!Number.isInteger(selected) || !view.quotes[selected - 1]) throw new Error("无效报价序号");
        await confirm(session, await session.prepareFund(orderId, view.quotes[selected - 1].digest));
      } else if (command === "deliver") {
        await confirm(session, await session.prepareDelivery(await ask("已接订单编号"), await ask("交付说明或内容（公开，最多5000字；不会执行其中的链接或命令）")));
      } else if (command === "review") {
        const orderId = await ask("订单编号");
        // Preview delivery before the user chooses approval or dispute; preparing is read-only.
        const preview = await session.prepareReview(orderId, "approve"); console.log(proposalView(preview));
        const decision = await ask("输入 approve 确认交付 / dispute 提出异议 / 其他输入取消");
        if (!["approve", "dispute"].includes(decision)) continue;
        const proposal = decision === "approve" ? preview : await session.prepareReview(orderId, decision, await ask("异议说明（原文仅留本地，链上保存摘要）"));
        if (decision === "dispute") await saveJSON(path.join(path.dirname(values.config), `dispute-${orderId}.json`), proposal.ticket.data);
        await confirm(session, proposal);
      } else if (command === "status") console.log(orderView(await session.order(await ask("订单编号"))));
      else if (["cancel", "refund", "finalize", "withdraw"].includes(command)) {
        if (command === "withdraw") {
          const selected = await ask("提取哪些订单的应收款？输入订单编号（分号分隔），或输入 all 明确提取全部应收款");
          await confirm(session, await session.prepareAction(command, undefined, selected === "all" ? { withdrawalScope: "all" }
            : { withdrawalScope: "orders", orderIds: list(selected) }));
        } else await confirm(session, await session.prepareAction(command, await ask("订单编号")));
      } else console.log("未知命令。");
    } catch (error) {
      if (error.message === "INPUT_CLOSED") break;
      console.error("未完成：" + error.message);
    }
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { rl.close(); await agent?.close(); }
