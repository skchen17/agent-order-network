import { formatUnits, ZeroAddress } from "ethers";
import { STATUS } from "./order-client.mjs";

const when = seconds => new Date(Number(seconds) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC");
const statuses = { Open: "等待报价", Funded: "已选供应方并锁款", Submitted: "等待买方检查交付", Disputed: "存在争议", Completed: "已确认付款", Cancelled: "已取消", Refunded: "已退款" };
const headings = { publish: "发布公开需求", quote: "发布报价", fund: "选定供应方并锁款", deliver: "提交公开交付", approve: "确认交付并放款", dispute: "提出交付异议", cancel: "取消未成交订单", refund: "申请超时退款", finalize: "触发无异议付款", withdraw: "提取自己的余额" };
export function demandView(draft, { symbol = "TESTUSD", realFunds = false } = {}) {
  if (!draft) return "";
  const lines = [`需求：${draft.title}`, `目标：${draft.objective}`, `原始描述：${draft.sourceText}`, `领域：${draft.category}；语言：${draft.language}；格式：${draft.format}`,
    `需要技能：${draft.skills.join("、")}`];
  for (const [key, label] of [["requirements", "必须满足"], ["deliverables", "交付物"], ["exclusions", "不包含"], ["conditions", "特殊情况约定"], ["acceptance", "确认交付的依据"], ["questions", "尚未澄清"]]) {
    if (draft[key].length) lines.push(`${label}：`, ...draft[key].map(text => `  - ${text}`));
  }
  lines.push(`预算上限：${draft.budget} ${symbol}${realFunds ? "" : "（无价值测试款）"}`, `报价窗口：${draft.acceptHours}小时；从发布起最晚${draft.deliveryHours}小时交付`,
    `提交后检查期：${draft.reviewHours}小时；争议处理等待期：${draft.arbitrationHours}小时`);
  return lines.join("\n");
}
export function orderView(view, payment = {}) {
  const o = view.order;
  const { symbol = "TESTUSD", decimals = 6, realFunds = false } = payment;
  const status = view.status ?? STATUS[Number(o.status)];
  const lines = [`订单 ${view.orderId}：${statuses[status] ?? status}`, demandView(view.demand, { symbol, realFunds }) || o.description,
    `需求方：${o.buyer}`, `供应方：${o.provider === ZeroAddress ? "尚未选定" : o.provider}`,
    `报价截止：${when(o.acceptUntil)}；最晚交付：${when(o.latestDeliveryAt)}`];
  if (BigInt(o.price ?? "0") > 0n) lines.push(`成交金额：${formatUnits(o.price, decimals)} ${symbol}；约定交付时间：${when(o.deliverBy)}`);
  if (Number(o.reviewUntil) > 0) lines.push(`异议截止：${when(o.reviewUntil)}`);
  if (Number(o.disputeUntil) > 0) lines.push(`争议裁定截止：${when(o.disputeUntil)}`);
  lines.push(`约定评估地址：${o.evaluator}（开发配置默认离线）`);
  return lines.join("\n");
}
export function proposalView(proposal) {
  const { kind, data, context } = proposal.ticket;
  const payment = { symbol: context.paymentSymbol ?? "TESTUSD", decimals: Number(context.paymentDecimals ?? 6), realFunds: context.realFunds === true };
  const lines = [`待确认：${headings[kind]}`, `操作钱包：${context.address}`];
  if (data.order) lines.push(orderView(data, payment));
  else if (data.draft) lines.push(demandView(data.draft, payment), `报价截止：${when(data.request.acceptUntil)}；最晚交付：${when(data.request.latestDeliveryAt)}`, `约定评估地址：${data.request.evaluator}（默认离线）`);
  if (kind === "quote") lines.push(`本次报价：${data.price} ${payment.symbol}；承诺交付：${when(data.deliverBy)}；报价有效至：${when(data.validUntil)}`);
  if (kind === "fund") lines.push(`你选择的供应方：${data.selected.quote.provider}`, `本次锁款：${data.selected.amount} ${payment.symbol}；承诺交付：${when(data.selected.quote.deliverBy)}`);
  if (data.result) lines.push("交付的完整内容：", JSON.stringify(data.result, null, 2));
  if (kind === "dispute") lines.push(`你的异议：${data.evidence}`);
  if (kind === "withdraw") {
    lines.push(`提款范围：${data.withdrawalScope === "orders" ? "指定订单" : "本钱包全部应收款"}`,
      `本次提取：${formatUnits(data.amount, payment.decimals)} ${payment.symbol}；当前全部应收款：${formatUnits(data.totalCredits, payment.decimals)} ${payment.symbol}`);
    for (const item of data.allocations ?? []) lines.push(`订单 ${item.orderId}：${formatUnits(item.amount, payment.decimals)} ${payment.symbol}`);
  }
  lines.push(data.disclosure);
  return lines.join("\n");
}
export function matchesView(report, { symbol = "TESTUSD" } = {}) {
  const lines = [`本地检查：${report.scanned}笔；符合条件：${report.eligible}；显示前${report.results.length}笔；暂不可读取：${report.unreadable.length}笔`,
    `你的排序：${report.policy.sort}；无广告、规模或成交量加权`, report.coverage];
  for (const item of report.results) lines.push(`\n订单 ${item.orderId}：${item.title}；预算上限 ${item.budget} ${symbol}`,
    ...item.reasons.map(text => `  符合：${text}`), ...item.needsHumanReview.map(({ text }) => `  需自己核对：${text}`));
  if (report.unreadable.length) lines.push("部分正文读取失败，结果可能不完整；请查看完整检索记录。");
  return lines.join("\n");
}
