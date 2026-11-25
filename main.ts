// tiny-bot-gorun: breadth momentum with volatility-scaled sizing.
//
// Strategy (one sentence): hold whichever of the 7 Solana assets are
// simultaneously above their 21-hour average and showing positive
// 7-plus-17-hour momentum above a breadth-adaptive entry bar, sized
// inversely to their 12-hour realised volatility, and cut them on a
// hard breakdown, a trailing stop, or a portfolio-level drawdown brake.
//
// Why this shape: the dev window (2026-10-29..11-03) is a choppy
// downtrend in which every asset ends lower, so buy-and-hold loses
// about $869; a bot that only buys confirmed up-trends and otherwise
// sits in cash loses far less there, while in a rising window the same
// breadth filter puts it into most of the universe at up to 25% weight
// each. The edge is selectivity plus patience, not prediction: entries
// need two timeframes to agree (7h and 17h returns jointly positive),
// exits need a real breakdown (not one soft bar), and exits are
// deliberately harder to trigger than entries are to earn (hysteresis),
// so the bot does not churn on hourly noise.
//
// Rules, exactly:
//   - History: every symbol's closes, in bar order, as plain numbers
//     (ratios are scale-free, so raw closes are fine).
//   - Rebalance every 6 bars (counted from the first tradeable bar).
//     A symbol qualifies when: close > SMA(21); score = r7 + r17
//     above the entry bar; the 3-bar return is under +5% (never chase
//     a vertical spike); and it is not inside its 12-bar post-exit
//     cooldown. The entry bar is breadth-adaptive: when at least 3 of
//     the 7 symbols are simultaneously above their SMA(21) with a
//     positive score (a broad rally), the bar drops to 0 and the bot
//     buys the breadth; when breadth is thin it demands score > +2.5%,
//     so in a choppy downtrend it only buys the strongest bounces.
//   - Buys: every qualifier, up to all 7, at a volatility-scaled
//     weight w = clamp(0.20 * (0.015 / vol12), 0.08, 0.25) of equity,
//     where vol12 is the std of hourly log returns over the last 12
//     bars (0.015 when too short a history); each buy is capped by the
//     harness weight room and by an even split of available cash.
//     A sell's proceeds never fund a buy in the same reply: buys for a
//     rebalance whose sells went out wait until the next rebalance bar.
//   - Exits, checked every bar: sell a held symbol when its close is
//     8% below its peak close since entry (trailing stop), or 3% below
//     its SMA(21), or its 7-bar return is under -5%. A held symbol is
//     NOT sold at a rebalance merely for leaving the qualifier list;
//     it is sold there only on a hard fail: close 1% below SMA(21) or
//     score under -1%.
//   - Portfolio brake: when equity falls 8% below its run peak, sell
//     everything and cool every symbol for 12 bars.
//   - Every order caps slippage at 150 bps. No order is sent on a
//     warm-up batch.
//   - No position is ever resized while held; only entries and exits.
//
// Differences from the house baselines, by construction: buy-and-hold
// buys everything once and never sells; momentum holds the top 3 by
// 24-bar return and rebalances every 24 bars with no stops; ema-cross,
// macd-cci, rsi-bollinger and adx-momentum use single-asset oscillator
// triggers with no volatility sizing, no breadth concept and no
// portfolio brake. This bot uses 21/7/17-bar windows, 6-bar
// rebalances, a 12-bar volatility scaler, hysteresis exits and an 8%
// portfolio brake -- none of which any baseline uses.
//
// Determinism: no clock, no environment, no files, no randomness. All
// state derives from the batches the harness sends, so two runs on the
// same data send the same orders. Only the standard library and the
// vendored kit shim are used.
//
// Protocol: agent-fun/bars-replay/v1, spoken through the kit's
// TypeScript shim (vendor/makefun-bars.ts, a byte-identical copy of
// sdk/makefun-bars.ts).

import { runBars, type BarsState, type Batch, type BuyInput, type OrderInput } from './vendor/makefun-bars.ts';

const SMA_N = 21; // trend average, in bars
const R_SHORT = 7; // fast momentum leg, in bars
const R_LONG = 17; // slow momentum leg, in bars
const VOL_N = 12; // realised-vol window, in bars
const REBAL_EVERY = 6; // bars between rebalances
const MAX_SLIPPAGE_BPS = 150; // 1.5% from the latest close, on every order
const COOLDOWN_BARS = 12; // bars a symbol rests after an exit
const TRAIL_DROP = 0.08; // trailing stop: 8% below the position's peak close
const SMA_EXIT_GAP = 0.03; // per-bar exit: close 3% below SMA(21)
const MOM_EXIT = -0.05; // per-bar exit: 7-bar return under -5%
const HARD_SMA_GAP = 0.01; // rebalance hard fail: close 1% below SMA(21)
const HARD_SCORE = -0.01; // rebalance hard fail: score under -1%
const ENTRY_SCORE = 0.025; // entry bar when breadth is thin (score > +2.5%)
const BREADTH_MIN = 3; // symbols above SMA(21) with score > 0 that drop the bar to 0
const R3_CAP = 0.05; // entry guard: never chase a 3-bar spike over +5%
const BRAKE_DROP = 0.08; // portfolio brake: equity 8% below its run peak
const REF_VOL = 0.015; // reference hourly volatility for sizing
const BASE_WEIGHT = 0.15; // base weight before the volatility scaler
const MIN_WEIGHT = 0.08; // lightest volatility-scaled weight
const MAX_WEIGHT = 0.25; // heaviest weight (also the harness cap)

/** Per-symbol close history (raw closes; ratios are scale-free). */
const history = new Map<string, number[]>();
/** Peak close since entry, per held symbol (for the trailing stop). */
const peakClose = new Map<string, number>();
/** First bar index at which a symbol may be bought again. */
const coolUntil = new Map<string, number>();
/** Run peak equity (quote units), for the portfolio brake. */
let peakEquity = 0n;
/** Qualifiers from a rebalance whose sells went out; bought next rebalance. */
let pendingBuys: string[] = [];

/** Close-to-close return over k bars ending at the latest bar, or null. */
function ret(closes: number[], k: number): number | null {
  const n = closes.length;
  if (n <= k) return null;
  return closes[n - 1] / closes[n - 1 - k] - 1;
}

/** Simple moving average over the last k closes, or null. */
function sma(closes: number[], k: number): number | null {
  const n = closes.length;
  if (n < k) return null;
  let s = 0;
  for (let i = n - k; i < n; i++) s += closes[i];
  return s / k;
}

/** Std of hourly log returns over the last VOL_N bars, or null. */
function vol(closes: number[]): number | null {
  const n = closes.length;
  if (n <= VOL_N) return null;
  const lr: number[] = [];
  for (let j = n - VOL_N; j < n; j++) lr.push(Math.log(closes[j] / closes[j - 1]));
  const m = lr.reduce((a, x) => a + x, 0) / lr.length;
  return Math.sqrt(lr.reduce((a, x) => a + (x - m) * (x - m), 0) / lr.length);
}

/** Composite momentum score: fast plus slow return, or null. */
function score(closes: number[]): number | null {
  const r7 = ret(closes, R_SHORT);
  const r17 = ret(closes, R_LONG);
  if (r7 === null || r17 === null) return null;
  return r7 + r17;
}

/** How many symbols are above their SMA(21) with a positive score. */
function breadth(): number {
  let n = 0;
  for (const symbol of history.keys()) {
    const closes = history.get(symbol)!;
    const s = sma(closes, SMA_N);
    const sc = score(closes);
    if (s !== null && sc !== null && closes[closes.length - 1] > s && sc > 0) n++;
  }
  return n;
}

/** Whether the symbol passes the entry filter on the current bar. */
function qualifies(symbol: string, seq: number, entryBar: number): boolean {
  const closes = history.get(symbol);
  if (closes === undefined) return false;
  const s = sma(closes, SMA_N);
  const sc = score(closes);
  const r3 = ret(closes, 3);
  if (s === null || sc === null || r3 === null) return false;
  if (seq < (coolUntil.get(symbol) ?? -1)) return false;
  return closes[closes.length - 1] > s && sc > entryBar && r3 < R3_CAP;
}

/** Whether a held symbol has failed hard enough to sell at a rebalance. */
function hardFail(symbol: string): boolean {
  const closes = history.get(symbol);
  if (closes === undefined) return true;
  const s = sma(closes, SMA_N);
  const sc = score(closes);
  if (s === null || sc === null) return true;
  return closes[closes.length - 1] < s * (1 - HARD_SMA_GAP) || sc < HARD_SCORE;
}

/** Volatility-scaled target weight of equity for a fresh position. */
function targetWeight(symbol: string): number {
  const closes = history.get(symbol);
  const v = closes === undefined ? null : vol(closes);
  const volNow = v === null || v <= 0 ? REF_VOL : v;
  const w = BASE_WEIGHT * (REF_VOL / volNow);
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, w));
}

function sellAll(state: BarsState): OrderInput[] {
  const orders: OrderInput[] = [];
  for (const [symbol, p] of state.positions) {
    orders.push({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
    coolUntil.set(symbol, state.seq + COOLDOWN_BARS);
    peakClose.delete(symbol);
  }
  return orders;
}

function buys(state: BarsState, symbols: readonly string[]): BuyInput[] {
  const fresh = symbols.filter((s) => !state.positions.has(s) && state.close(s) !== null);
  if (fresh.length === 0 || state.cash <= 0n) return [];
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  const orders: BuyInput[] = [];
  const perName = state.cash / BigInt(fresh.length);
  for (const symbol of fresh) {
    const w = targetWeight(symbol);
    let notional = BigInt(Math.floor(Number(state.equity) * w));
    if (notional > perName) notional = perName;
    const room = state.weightRoom(symbol);
    if (notional > room) notional = room;
    if (notional < minNotional) continue;
    orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
  }
  return orders;
}

await runBars({
  onBatch(state: BarsState, batch: Batch): OrderInput[] {
    // Fold this batch's bars into history.
    for (const b of batch.bars) {
      const arr = history.get(b.symbol) ?? [];
      arr.push(Number(b.c));
      history.set(b.symbol, arr);
    }
    if (state.warmingUp) return [];
    if (state.equity > peakEquity) peakEquity = state.equity;
    for (const [symbol] of state.positions) {
      const c = state.close(symbol);
      if (c === null) continue;
      const cn = Number(c);
      const prev = peakClose.get(symbol) ?? cn;
      if (cn > prev) peakClose.set(symbol, cn);
    }

    // Portfolio brake: flatten everything on an 8% equity drawdown.
    if (state.positions.size > 0 && state.equity * 100n < peakEquity * BigInt(Math.round((1 - BRAKE_DROP) * 100))) {
      pendingBuys = [];
      return sellAll(state);
    }

    // Per-bar exits: trailing stop, SMA breakdown, momentum collapse.
    const exits: OrderInput[] = [];
    for (const [symbol, p] of state.positions) {
      const closes = history.get(symbol);
      const c = state.close(symbol);
      if (closes === undefined || c === null) continue;
      const cn = Number(c);
      const s = sma(closes, SMA_N);
      const r7 = ret(closes, R_SHORT);
      const peak = peakClose.get(symbol) ?? cn;
      if (cn < peak * (1 - TRAIL_DROP) || (s !== null && cn < s * (1 - SMA_EXIT_GAP)) || (r7 !== null && r7 < MOM_EXIT)) {
        exits.push({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    if (exits.length > 0) {
      pendingBuys = [];
      for (const o of exits) {
        if (o.side === 'sell') {
          coolUntil.set(o.symbol, state.seq + COOLDOWN_BARS);
          peakClose.delete(o.symbol);
        }
      }
      return exits;
    }

    // Only rebalance bars decide entries and rotation.
    const sinceWindow = state.seq - state.warmupBars;
    if (sinceWindow % REBAL_EVERY !== 0) return [];

    // Breadth-adaptive entry bar: a broad rally drops it to zero.
    const entryBar = breadth() >= BREADTH_MIN ? 0 : ENTRY_SCORE;

    // Buy the qualifiers deferred from the previous rebalance's sells.
    if (pendingBuys.length > 0) {
      const due = pendingBuys.filter((s) => qualifies(s, state.seq, entryBar));
      pendingBuys = [];
      return buys(state, due);
    }

    // Rotation: sell only hard failures, never for ranking alone.
    const sells: OrderInput[] = [];
    for (const [symbol, p] of state.positions) {
      if (hardFail(symbol)) {
        sells.push({ side: 'sell', symbol, qty: p.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
      }
    }
    const ranked = state.hello.symbols
      .map((s) => s.symbol)
      .filter((s) => qualifies(s, state.seq, entryBar))
      .map((s) => ({ symbol: s, sc: score(history.get(s)!)! }))
      .sort((a, b) => b.sc - a.sc)
      .map((x) => x.symbol);
    if (sells.length > 0) {
      pendingBuys = ranked;
      for (const o of sells) {
        if (o.side === 'sell') {
          coolUntil.set(o.symbol, state.seq + COOLDOWN_BARS);
          peakClose.delete(o.symbol);
        }
      }
      return sells;
    }
    return buys(state, ranked);
  },
});
