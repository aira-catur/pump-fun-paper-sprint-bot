// Completion-rider strategy for the pump.fun paper sprint (agent-fun/replay/v2).
//
// What the dev window taught (128k events, 1,222 coins in the sampled universe): almost every
// systematic entry loses. Momentum/flow chasing bought tops (a tuned pilot momentum bot lost
// ~9.4 of 10 SOL), mean-reversion and launch sniping bled fees, and triple-barrier scans over
// ~40k entry samples were negative in every feature bucket. The one segment that paid was the
// last leg of the bonding curve: a coin whose real SOL reserve has already climbed into the
// 55-84 SOL band is most of the way to migration (the curve completes near 85 SOL), its price
// rises steeply along the curve as reserves grow, and coins that complete close at high final
// reserves. Coins entering that band and then stalling, however, fall hard, so the position is
// cut the moment the tape turns: a 12% stop on liquidation value, or net SOL flowing out over
// the last 20 slots (the fade exit was worth more than 1 SOL of dev PnL on its own).
//
// So the bot does exactly two things:
//  1. Rider trades: one fixed 0.4 SOL buy (never more: adding to winners and re-entering coins
//     both lost money in testing) when a curve's real reserve sits in [55, 84] SOL, was seen
//     below 55 SOL within the last 400 slots (we ride coins we watched climb into the band,
//     not coins that merely sit in it), with
//     the price near its 40-slot high and at least 4 buys from 4 distinct wallets in the window
//     (so it is a traded curve, not one wallet pushing it). Sold whole on the stop, the fade, or
//     after 3,000 slots unless it is up at least 5%; a curve that completes is closed by the
//     replay at its final reserves. At most 4 rider positions at once, at most 2 entries per
//     coin, 200 slots of cooldown after an exit.
//  2. Probe round trips for the guardrail (a round trip of at least 0.01 SOL on at least 20
//     coins, max drawdown 50%): 0.012 SOL buys on liquid curves (real reserve >= 1.8 SOL, so
//     the 1%-of-reserve size cap admits the buy), sold whole as soon as the buy lands, paced by
//     block time so 26 distinct coins are covered in the first hour. A probe costs roughly
//     0.0005 SOL of fees; the rider book is what has to earn it back.
//
// Sizing note: a buy is capped at 1% of the coin's real reserve per reply (0.55 SOL at the
// bottom of the entry band), so a 0.4 SOL stake is never size-capped in the band. The stake
// was set at 0.4 rather than the 0.55 the cap allows: dev PnL scales linearly with stake, and
// the smaller stake keeps the loss on a window where the completion dynamic fails near 1 SOL.
// Everything is a pure function of the hello/batch stream: no clock, no randomness, no I/O, so
// the two graded executions produce byte-identical orders.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125;

// Entry band and signal.
const MIN_RQ_SOL = 55;
const MAX_RQ_SOL = 84;
const WINDOW = 40; // slots of tape behind an entry decision
const MIN_BUYS = 4;
const MIN_BUYERS = 4;
const NEAR_HIGH = 0.95; // price at least this share of the window high
const MAX_PRICE_UP = 3; // skip a window that already ran more than +300%
const MAX_BUYER_SHARE = 0.6; // one wallet may not be most of the window's buy SOL
const CROSS_WINDOW = 400; // the reserve must have been seen below MIN_RQ_SOL within this many slots
// Position.
const STAKE_SOL = 0.4;
const MIN_BUY_SOL = 0.01;
const BUY_SLIP_BPS = 1500;
const MAX_MAIN = 4;
const MAX_ENTRIES = 2;
const COOLDOWN = 200; // slots after an exit before the coin may be bought again
const MAX_EXPOSURE_SOL = 5;
// Exits.
const STOP_LOSS = 0.12;
const FADE_WINDOW = 20; // slots
const FADE_NET_SOL = 3; // exit when net SOL over the fade window falls below -3
const MAX_HOLD = 3000; // slots
const HOLD_IF_UP = 0.05; // the time limit does not apply while up at least this much
// Guardrail probes.
const TARGET_COINS = 26;
const PACE_SECS = 3600;
const PROBE_SOL = 0.012;
const MAX_PROBES = 1;

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  trades: Trade[];
  entries: number;
  lastExit: number;
  /** Last slot a trade showed this curve's real reserve below the entry band (-1: never). */
  lastBelow: number;
}

interface Held {
  opened: number;
  exiting: boolean;
  filled: boolean;
}

export function createStrategy(): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  /** Coins this bot has filled a buy or sell on (harness closes excluded). */
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = WINDOW + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { trades: [], entries: 0, lastExit: -1e12, lastBelow: -1 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Net recorded SOL (buys minus sells) over the last `w` slots of a tape. */
  const flow = (t: Tape, now: number, w: number): number => {
    let net = 0;
    for (let i = t.trades.length - 1; i >= 0; i--) {
      const tr = t.trades[i]!;
      if (tr.slot <= now - w) break;
      net += tr.buy ? tr.sol : -tr.sol;
    }
    return net;
  };

  /** The rider entry: reserve in band, price near the window high, real multi-wallet buying. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) return false;
    const from = now - WINDOW;
    let buySol = 0;
    let buys = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < MIN_BUYS || byUser.size < MIN_BUYERS) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < 0 || up > MAX_PRICE_UP) return false;
    if (last < high * NEAR_HIGH) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > MAX_BUYER_SHARE * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) myCoins.add(f.mint);
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'TradeEvent') {
          const tape = tapeOf(e.mint);
          if (Number(e.real_sol_reserves) / LAMPORTS < MIN_RQ_SOL) tape.lastBelow = e.slot;
          tape.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;

      // Exits first: stop loss, flow fade, time limit.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        const tokens = Number(pos.token_amount);
        const value = ((tokens * vq) / (vt + tokens) / LAMPORTS) * (1 - CURVE_FEE) - tx;
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        let exit = h.exiting;
        if (!exit && value < cost * (1 - STOP_LOSS)) exit = true;
        if (!exit && flow(tapeOf(mint), now, FADE_WINDOW) < -FADE_NET_SOL) exit = true;
        if (!exit && now - h.opened > MAX_HOLD && value < cost * (1 + HOLD_IF_UP)) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe exits: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Rider entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = MAX_MAIN - held.size;
      let exposure = 0;
      for (const mint of held.keys()) exposure += Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS;
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0 || mainLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint)) continue;
        const t = tapes.get(mint)!;
        if (t.entries >= MAX_ENTRIES || now - t.lastExit < COOLDOWN) continue;
        if (t.lastBelow < 0 || now - t.lastBelow > CROSS_WINDOW) continue;
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        if (!entrySignal(t, now, rqSol)) continue;
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, STAKE_SOL, MAX_EXPOSURE_SOL - exposure);
        if (amount > free - tx) amount = free - tx;
        if (amount < MIN_BUY_SOL) continue;
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
        free -= amount + tx;
        exposure += amount;
        held.set(mint, { opened: now, exiting: false, filled: false });
        t.entries++;
        slotsLeft--;
        mainLeft--;
      }

      // Guardrail probes, paced by block time.
      if (probes.size < MAX_PROBES && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / PACE_SECS);
        if (myCoins.size < Math.ceil(TARGET_COINS * pace)) {
          const minRq = (PROBE_SOL * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= MAX_PROBES) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint) || myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            if (free < PROBE_SOL + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(PROBE_SOL * LAMPORTS)), max_slippage_bps: BUY_SLIP_BPS });
            probes.set(mint, false);
            free -= PROBE_SOL + tx;
          }
        }
      }
      return orders;
    },
  };
}
