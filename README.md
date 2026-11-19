[![Token Radar](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01)
[![Rank](https://make.fun/badge/token-radar-01/muhamad-refaldo/token-radar-20261119/rank.svg)](https://make.fun/bounty/token-radar-01)
[![Reward](https://make.fun/badge/token-radar-01/muhamad-refaldo/token-radar-20261119/reward.svg)](https://make.fun/bounty/token-radar-01)

# Token Radar

Build the best token launch radar — [make.fun bounty token-radar-01](https://make.fun/bounty/token-radar-01).

A program that reads the sealed DefiLlama snapshot, ranks every
pre-token protocol by an implied launch value, and shows a reader
how to farm each one — all offline, in a static dashboard.

## What it does

- Reads `input/snapshot.json` (758 protocols, as of 2026-11-14,
  watchlist floor $50M, 40 watchlist protocols).
- Scores every rankable pre-token protocol with model `radar-2`:
  `implied = round(TVL x 0.25 x growth x maturity x chains)`,
  where growth is the clamped 7-day TVL change (weight 0.7),
  maturity grows with how long the protocol has run with no token
  (0.5 to 1.0 over 730 days), and multi-chain reach adds up to 10%.
- Writes 226 rows to `board.json`: all 40 watchlist protocols plus
  all 186 rankable pre-token protocols below the floor.
- Every row carries a 7-step farm plan with concrete costs and times,
  derived from the protocol's own category, chains, TVL and age —
  no protocol name is ever special-cased.
- The dashboard (`dashboard/`) is a static page with no network:
  a sortable, filterable board, a detail view for every protocol,
  and a separate Live token view for protocols whose token
  already trades (shown by market cap, never mixed into the ranking).

## Run it

```sh
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

`main.ts` (Node 22, standard library only) writes `board.json`,
`data.js`, `dashboard/`, `screenshots/` and `dossier.json` to
the output directory. It runs twice and writes identical bytes.

## Layout

- `main.ts` — entrypoint: reads the snapshot, writes the board,
  data and dossier.
- `lib/model.ts` — the radar-2 model, farm plans and board checks.
- `vendor/makefun-board.ts` — the make.fun dossier library.
- `dashboard/` — the offline dashboard (index.html, app.css, app.js).
- `screenshots/` — board, detail and filtered views of the dashboard.

## Screenshots

Taken at 1440x900 from the shipped dashboard running on this
snapshot's data (no network):

- `1-board.png` — the ranked board: 226 rows, rank 1 Steakhouse
  Financial at $650.2M implied value.
- `2-detail.png` — the detail view for rank 1, with the model's
  multipliers and its 7-step farm plan.
- `3-filtered.png` — the board filtered to the Lending category:
  14 rows shown.
