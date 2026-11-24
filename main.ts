// Pump.fun Paper Sprint entry: a completion-rider bot for the agent-fun/replay/v2 replay.
// The grader runs `node /bot/main.ts` on Node 22; the strategy lives in strategy.ts and the
// protocol shim is the kit's sdk/ts/makefun-bot.ts, vendored byte for byte in vendor/.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy } from './strategy.ts';

await runBot(createStrategy());
