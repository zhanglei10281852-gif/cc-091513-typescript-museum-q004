import { createApp } from "./app.js";
import { SafetyGateService } from "./service.js";
import { Store } from "./store.js";

const port = Number.parseInt(process.env.PORT ?? "8000", 10);
const host = process.env.HOST ?? "0.0.0.0";
const stateDir = process.env.STATE_DIR ?? ".runtime";

// 状态持久化到 STATE_DIR/state.json；进程重启后倒计时、停用状态与
// 未确认事故均按持久化的原时点继续推进。
const service = new SafetyGateService(new Store(stateDir));

createApp(service).listen(port, host, () => {
  process.stdout.write(`service listening on ${host}:${port}\n`);
});
