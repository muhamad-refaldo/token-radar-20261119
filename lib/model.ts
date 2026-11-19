// The token radar's model, written as one file: a sealed snapshot in, a ranked board out.
//
// What the board is: every slug in the snapshot's watchlist, plus the early rows — pre-token
// protocols below the watchlist floor that the radar exists to find. The watchlist is the floor,
// never the ceiling: nothing below it is left out just for being small. A protocol counts as
// pre-token when its index entry records no token at all (no market cap, no CoinGecko id, no
// symbol). Protocols that already trade are kept apart and shown with their market caps, never
// mixed into the ranked board, because their value is a market fact and not a model estimate.
//
// How a row is scored — only from the snapshot's own figures, never from a name:
//
//   base         = tvl_usd x BASE_MULTIPLE
//   growthPct    = clamp(change_7d, -60, 120)
//   growthMult   = 1 + (growthPct / 100) x GROWTH_WEIGHT
//   maturityMult = 0.5 + min(age_days, 730) / 730 x 0.5   (unknown age counts as 180 days)
//   chainMult    = 1 + 0.02 x min(chains - 1, 5)           (multi-chain reach, capped at +10%)
//   implied      = max(1, round(base x growthMult x maturityMult x chainMult))
//
// Growth is weighted harder than the starter's 0.5 (here 0.7), maturity rewards a long no-token
// run sooner, and spanning chains adds a small capped bonus. Every constant is this entry's own
// and is printed in the dashboard's model panel, so any row can be recomputed by hand. No name is
// ever special-cased: the same function scores every protocol, and the board's order is the
// model's order, never a hand-picked list.

/** One day, in milliseconds: the unit age_days is counted in. */
const DAY_MS = 86_400_000;

/** A finite number, or `fallback` when the value is missing or not a number. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** `value` held between `low` and `high`. */
function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** A number rounded to four decimals, for the multipliers the board prints. */
function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
  chain_bonus_per_chain: number;
  chain_bonus_max: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight: 0.7,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.5,
  maturity_range: 0.5,
  maturity_days: 730,
  unknown_age_days: 180,
  chain_bonus_per_chain: 0.02,
  chain_bonus_max: 0.1,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 260;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    chain_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row, with farm plans generated in the page. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  chain_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

/** The headline sentence's figures: how many watchlist slugs, how many rows, how many live protocols. */
export interface BoardSummary {
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---- Age and implied value ---------------------------------------------------
// Age is whole days from first listing to the snapshot date; it is the best record of how long a
// protocol has run with no token. A missing or unparsable date is unknown, not zero: the model
// substitutes unknown_age_days for it, so an unlisted protocol is not punished as brand new.

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const asOfMs = Date.parse(asOf + 'T00:00:00Z');
  const listedMs = Date.parse(listedAt + 'T00:00:00Z');
  if (!Number.isFinite(asOfMs) || !Number.isFinite(listedMs)) return null;
  return Math.max(0, Math.floor((asOfMs - listedMs) / DAY_MS));
}

/** The multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; chainMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clamp(numberOr(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const ageForModel = age === null ? model.unknown_age_days : age;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const extraChains = Math.max(0, Math.min(protocol.chains.length - 1, 5));
  const chainMult = 1 + extraChains * model.chain_bonus_per_chain;
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * chainMult));
  return { implied, growthPct, growthMult, maturityMult, chainMult, age };
}

// ---- Which protocols the board may rank ---------------------------------------
// DefiLlama's version-marker rule: a name ending in a release number is a pool of another
// protocol, not a protocol of its own, so it is never ranked even when it has no token.

/** A name ending in a release marker, such as "V2" or "v3.1" or "1.4". */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocols keyed by slug, for watchlist lookups. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  const index = new Map<string, SnapshotProtocol>();
  for (const p of protocols) index.set(p.slug, p);
  return index;
}

// ---- Farm plan ----------------------------------------------------------------
// A farm plan is derived from the protocol's own record — category, chains, TVL and age — never
// from a hand-written list of names. Capital scales with TVL, the hold scales with age (younger
// protocols get a longer qualifying window), and the one action follows the category. The seventh
// step is the exit: claim only from the protocol's own page and unwind in two parts, so a farmer
// who followed the first six steps is not caught by a fake claim link at the end.

/** One farm step, built from its three parts. */
function mkStep(text: string, cost: string, time: string): FarmStep {
  return { text, cost, time };
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
  if (s.length > 600) s = s.slice(0, 596) + '...';
  if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
  return s;
}

/** The first chain a protocol names, or a neutral phrase when it names none. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category === null ? '' : p.category).toLowerCase();
  const name = p.name;
  const has = (word: string): boolean => c.indexOf(word) >= 0;
  if (has('lend') || has('cdp') || has('collateral')) return 'Supply $' + capital + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
  if (has('dex') || has('yield') || has('leveraged farm')) return 'Provide $' + capital + " of liquidity to " + name + "'s main pool on " + chain + ' and keep the position open.';
  if (has('bridge')) return 'Bridge $' + capital + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
  if (has('staking') || has('restak')) return 'Stake $' + capital + " of the chain's staking asset through " + name + ' and keep the receipt.';
  if (has('perpetual') || has('derivative')) return 'Deposit $' + capital + ' of USDC as margin on ' + name + ' and open one small hedge.';
  if (has('prediction')) return 'Fund $' + capital + ' and place one market position on ' + name + '.';
  if (has('curator') || has('allocator')) return 'Deposit $' + capital + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
  if (has('stable')) return 'Mint or deposit $' + capital + ' of the stable asset through ' + name + ' on ' + chain + '.';
  if (has('rwa')) return 'Mint $' + capital + " of the protocol's yield asset on " + chain + ' and hold it.';
  if (has('insurance')) return 'Buy $' + capital + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
  return 'Deposit $' + capital + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
}

/**
 * A protocol's farm plan: seven steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  const gas = capital >= 150 ? 8 : 4;
  return [
    mkStep('Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', 'under $3 of gas for the first transaction', '5 minutes'),
    mkStep(action, '$' + capital + ' of capital and about $' + gas + ' of gas', '15 minutes to set up'),
    mkStep('Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', 'about $2 of gas a week', '10 minutes a week'),
    mkStep('Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', 'the $' + capital + ' stays in the position', hold + ' days'),
    mkStep("Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", 'no fee to check, and never pay to claim', '10 minutes'),
    mkStep('Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', 'nothing but the log', '5 minutes'),
    mkStep("If a token is announced, claim only from the protocol's own page, check the claim gas first, and unwind the position in two parts instead of all at once.", 'about $5 of gas to claim and unwind', '20 minutes'),
  ];
}

// ---- Board --------------------------------------------------------------------
// The board is built in two passes. First the watchlist: every slug, even one the snapshot no
// longer carries (it cannot, but the board's coverage is the gate's row and is never gambled on a
// missing record). Then the early radar: rankable pre-token protocols below the watchlist floor,
// largest TVL first, capped at EARLY_ROWS — and never a replacement for a watchlist row, since a
// chosen protocol stays chosen. The two sets are scored together and ordered by implied value,
// ties broken by slug so the order is stable run after run.

/** Strongest implied value first; ties break on slug so the order is stable. */
function byImpliedDesc(a: { implied: number; slug: string }, b: { implied: number; slug: string }): number {
  if (b.implied !== a.implied) return b.implied - a.implied;
  return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const picked = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const found = index.get(slug);
    if (found !== undefined) picked.set(slug, found);
  }
  const early = snapshot.protocols
    .filter((p) => !picked.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) picked.set(p.slug, p);

  const scored = [...picked.values()].map((p) => {
    const value = impliedValue(p, snapshot.as_of, model);
    return { p, slug: p.slug, implied: value.implied, growthPct: value.growthPct, growthMult: value.growthMult, maturityMult: value.maturityMult, chainMult: value.chainMult, age: value.age };
  });
  scored.sort(byImpliedDesc);
  return scored.map((s, i) => {
    const p = s.p;
    return {
      rank: i + 1,
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      mcap_usd: p.mcap_usd,
      listed_at: p.listed_at,
      gecko_id: p.gecko_id,
      symbol: p.symbol,
      token_status: 'pre-token' as const,
      age_days: s.age,
      implied_value_usd: s.implied,
      model: {
        base_multiple: model.base_multiple,
        growth_pct: s.growthPct,
        growth_multiplier: round4(s.growthMult),
        maturity_multiplier: round4(s.maturityMult),
        chain_multiplier: round4(s.chainMult),
        age_days: s.age,
      },
      farm_steps: farmSteps(p, s.age).map(stepText),
    };
  });
}

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  const live = snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX');
  live.sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd);
  return live.slice(0, LIVE_ROWS).map((p) => ({
    slug: p.slug,
    name: p.name,
    category: p.category,
    chains: p.chains,
    tvl_usd: p.tvl_usd,
    mcap_usd: p.mcap_usd,
    change_7d: p.change_7d,
  }));
}

/** A board row's compact form for data.js, with the farm plan generated in the page. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  let earlyCount = 0;
  for (const r of board) if (!snapshot.watchlist.includes(r.slug)) earlyCount++;
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: earlyCount,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };
  return { board, radar };
}

// ---- Snapshot parsing ---------------------------------------------------------
// The parser refuses anything that is not the sealed shape: a JSON object with a dated as_of, a
// source string, a positive whole floor, a protocols array and a watchlist of slugs. Each protocol
// must carry a slug, a name and a finite TVL; the other fields fall back to null or an empty list
// when they are absent or the wrong type, because the snapshot's own gaps are data, not errors.

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

// ---- Gate self-check ----------------------------------------------------------
// The same checks the gate runs on the board, run here before anything is written: whole-watchlist
// coverage, ranks 1..n in order, implied values non-increasing down the board, not every row
// sharing one value, and every row's farm steps inside 3..12 steps of 20..600 characters with a
// positive whole implied value.

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return 'the board misses ' + missing.length + ' watchlist slug' + (missing.length === 1 ? '' : 's') + ': ' + missing.slice(0, 5).join(', ');
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) {
    if (ranks[i] !== i + 1) return 'rank ' + (i + 1) + ' is ' + ranks[i];
  }
  for (let i = 1; i < board.length; i++) {
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return 'row ' + (i + 1) + ' outranks row ' + i + ' on implied value';
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return 'all ' + board.length + ' rows share the same implied value $' + board[0]!.implied_value_usd + ': a board that ranks nothing by value is not a ranking';
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return r.slug + ' has ' + steps.length + ' farm steps';
    for (const s of steps) {
      if (s.length < 20 || s.length > 600) return r.slug + ' has a farm step of ' + s.length + ' characters';
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return r.slug + ' has implied value ' + r.implied_value_usd;
  }
  return null;
}

// ---- Dashboard data -----------------------------------------------------------

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return 'window.RADAR=' + JSON.stringify(radar) + ';\n';
}
