import { runSkillScenario } from "./skill-scenario.mjs";
import { json } from "../src/agent-runtime.mjs";
console.log("演示宿主Agent结构化工具调用；授权与模型理解输入均为测试夹具，不启动交互客户端或本地模型。");
console.log(json(await runSkillScenario()));
