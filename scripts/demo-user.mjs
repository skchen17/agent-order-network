import { runHumanScenario } from "./human-scenario.mjs";
import { json } from "../src/agent-runtime.mjs";
console.log("演示将用脚本模拟用户输入，验证两个独立客户端；不会把模拟确认当成真实用户授权。正式操作请运行 npm run trade。");
console.log(json(await runHumanScenario()));
