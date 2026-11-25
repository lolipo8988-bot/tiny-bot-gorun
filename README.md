[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/lolipo8988-bot/tiny-bot-gorun/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/lolipo8988-bot/tiny-bot-gorun/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

# tiny-bot-gorun

A tiny Solana paper-trading bot for make.fun's "Tiny Bot, Easy $2: Beat
Buy-and-Hold on Solana" bounty. It trades the 7 hourly Solana assets
(FARTCOIN, JITOSOL, POPCAT, RAY, SOL, WETH, WIF) on the
agent-fun/bars-replay/v1 harness.

## Strategy

Breadth momentum with volatility-scaled sizing, hysteresis exits and a
portfolio drawdown brake — designed to be behaviourally different from
buy-and-hold and from every house baseline:

- **Entry (every 6 bars):** a symbol qualifies when its close is above
  its 21-hour SMA, its composite momentum score (7-hour + 17-hour
  return) clears a breadth-adaptive bar, its 3-hour return is under
  +5% (never chase a spike), and it is out of its 12-bar post-exit
  cooldown. When at least 3 of the 7 symbols are above their SMAs with
  positive scores (a broad rally) the bar drops to 0 and the bot buys
  the breadth; when breadth is thin it demands score > +2.5%, so in a
  choppy downtrend it only buys the strongest bounces.
- **Sizing:** each fresh position gets a volatility-scaled weight of
  equity, `clamp(0.15 * (0.015 / vol12), 0.08, 0.25)`, where `vol12`
  is the 12-hour realised volatility; capped by the harness 25%
  weight room and an even split of available cash.
- **Exits (checked every bar):** 8% trailing stop below the position's
  peak close, close 3% below the 21-hour SMA, or 7-hour return under
  −5%. At a rebalance a held symbol is sold only on a hard fail
  (close 1% below its SMA or score under −1%) — never merely for
  leaving the qualifier list.
- **Portfolio brake:** if equity falls 8% below its run peak, sell
  everything and rest every symbol for 12 bars.
- **Execution:** every order caps slippage at 150 bps; no order on a
  warm-up batch; a sell's proceeds never fund a buy in the same reply
  (buys deferred from a rebalance with sells wait for the next
  rebalance bar). Fully deterministic: no clock, environment, files
  or randomness.

This is not buy-and-hold (which buys everything once and never sells),
not the momentum baseline (top 3 by 24-bar return, 24-bar rebalances,
no stops), and not any oscillator baseline: different lookbacks
(21/7/17), 6-bar rebalances, a 12-bar volatility scaler, hysteresis
exits and an 8% portfolio brake.

## Local backtest (dev window, 2026-10-29..11-03, 136 hourly bars)

Run from the kit directory (the kit is what the server grades the dev
phase with; `--driver process` because this machine has no Docker):

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

Results (two executions, reproduced byte for byte):

- **Net PnL: +$97.39 USDC** (+0.97%; 90% interval −$52.25 .. +$250.54)
- **Buy-and-hold baseline: −$869.34 USDC** → margin over buy-and-hold **+$966.72**
- 21 trades over 7 symbols, win rate 21.4%, max drawdown 2.58%,
  exposure 34.8%, Sharpe 0.032; fees $40.37 (net PnL at 2x fees: +$57.05)
- Guardrails met (≥8 trades, max drawdown ≤25%); 0 rejected orders

The dev window is a choppy downtrend in which every asset ends lower,
so the bot's edge is selectivity: it stays mostly in cash and only
buys confirmed bounces, while buy-and-hold rides the whole decline.
Stress checks on synthetic up-market mirrors of the same data
(time-inverted and time-reversed series) keep the bot profitable in
absolute terms (+$446 on the reversed series) with the same rules —
it lags buy-and-hold in a smooth broad rally, as any selective bot
must, but does not blow up there.

## Files

- `main.ts` — the bot (Node 22, standard library only; speaks
  agent-fun/bars-replay/v1 through the vendored kit shim)
- `vendor/makefun-bars.ts` — byte-identical copy of the kit's
  `sdk/makefun-bars.ts`
- `LICENSE` — MIT

## Bounty

https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1
