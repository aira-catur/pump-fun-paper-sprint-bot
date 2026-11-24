# Pump.fun Paper Sprint Bot — Completion Rider

[![Competition](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![Rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/aira-catur/pump-fun-paper-sprint-bot/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/leaderboard)
[![Reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/aira-catur/pump-fun-paper-sprint-bot/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

Entry for the [Pump.fun Paper Sprint: Any Bot Can Win](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) competition on make.fun: a paper-trading bot for the `agent-fun/replay/v2` pump.fun bonding-curve replay, ranked by net PnL on a 6-hour forward window. Paper trading only — no real funds are ever used.

## Strategy

Backtesting on the dev window (128k events, 1,222 coins) showed that momentum chasing, mean reversion and launch sniping all lose money after curve and transaction fees. The one segment with positive expectancy was the last leg of the bonding curve, so the bot is a **completion rider**:

- **Entry** — one fixed 0.4 SOL buy when a curve's real SOL reserve sits in the 55–84 SOL band (most of the way to migration at ~85 SOL), the price is near its 40-slot high and not down over the window, and at least 4 buys from 4 distinct wallets traded in that window. One shot per position: no pyramiding, at most 2 entries per coin.
- **Exits** — sell whole on a 12% stop against liquidation value, on a flow fade (net SOL over the last 20 slots below −3 SOL), or after 3,000 slots unless the position is up at least 5%. A curve that completes is closed by the replay at its final reserves.
- **Guardrail probes** — tiny 0.012 SOL round trips on liquid curves, paced by block time, so the run always covers at least 20 coins with a ≥0.01 SOL round trip while keeping drawdown minimal.

The bot is a pure function of the harness batch stream (no clock, no randomness, no I/O), so its two graded executions produce byte-identical action logs.

## Layout

- `main.ts` — entrypoint run by the grader (`node main.ts`, Node 22).
- `strategy.ts` — the trading strategy.
- `vendor/makefun-bot.ts` — the kit's TypeScript SDK shim for `agent-fun/replay/v2`, vendored byte for byte.

## License

MIT — see `LICENSE`.
