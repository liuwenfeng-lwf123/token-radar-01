// token-radar-01: a token launch radar, written from scratch for this bounty.
//
// Reads a frozen DefiLlama protocol snapshot, ranks every pre-token protocol
// by an implied launch value derived only from the snapshot's own figures,
// writes the ranked board, the dashboard data, and the judge dossier.
//
//   mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>
//
// Node 22, standard library only, no network, fully deterministic: the same
// snapshot always writes the same bytes. No Date.now, no Math.random.
//
// Value model (radar-2), one function scores every protocol, no name is ever
// special-cased:
//
//   implied = round( tvl_usd x categoryMultiple
//                    x (1 + clamp(change_7d, -50, 100) / 100 x 0.60)
//                    x (0.70 + min(age_days, 1095) / 1095 x 0.50)
//                    x (1 + min(chains - 1, 4) x 0.03) )
//
//   categoryMultiple: what a dollar of TVL is worth as launch value, by sector
//     (lending and derivatives earn more per TVL dollar than a bridge, whose
//     TVL mostly passes through). Age is days since DefiLlama first listed the
//     protocol; unknown age counts as 365 days. Multi-chain reach adds up to
//     12%: a protocol live on more chains has more users to reward.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDossier } from './vendor/makefun-board.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const TEXT_MAX_BYTES = 65_536;
const DAY_MS = 86_400_000;
const EARLY_ROWS = 180;
const LIVE_ROWS = 24;

interface Protocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}
interface Snapshot { as_of: string; source: string; floor_usd: number; protocols: Protocol[]; watchlist: string[]; }

interface Model {
  growthWeight: number; growthFloor: number; growthCap: number;
  maturityFloor: number; maturityRange: number; maturityDays: number;
  unknownAgeDays: number; chainStep: number; chainMax: number;
}
const MODEL: Model = {
  growthWeight: 0.6, growthFloor: -50, growthCap: 100,
  maturityFloor: 0.7, maturityRange: 0.5, maturityDays: 1095,
  unknownAgeDays: 365, chainStep: 0.03, chainMax: 4,
};
const MODEL_VERSION = 'radar-2';

// Launch value per TVL dollar, by sector. A bridge moves other people's
// money, a lender or RWA issuer keeps a spread: the multiple says so.
const CATEGORY_MULTIPLE: Record<string, number> = {
  'lending': 0.30, 'derivatives': 0.30, 'perpetuals': 0.30, 'basis trading': 0.30,
  'rwa': 0.35, 'dexs': 0.28, 'cdp': 0.28, 'collateral markets': 0.28,
  'onchain capital allocator': 0.28, 'risk curators': 0.26, 'restaking': 0.26,
  'yield': 0.24, 'yield aggregator': 0.24, 'leveraged farming': 0.24,
  'liquid staking': 0.20, 'liquid restaking': 0.20, 'staking pool': 0.20,
  'stablecoin': 0.22, 'bridge': 0.18, 'canonical bridge': 0.18,
  'insurance': 0.22, 'prediction market': 0.26, 'options': 0.28,
  'synthetics': 0.26, 'payments': 0.24, 'governance incentives': 0.20,
};
const DEFAULT_MULTIPLE = 0.22;

function categoryMultiple(category: string | null): number {
  if (category === null) return DEFAULT_MULTIPLE;
  return CATEGORY_MULTIPLE[category.toLowerCase()] ?? DEFAULT_MULTIPLE;
}

function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

interface Scored {
  implied: number; growthPct: number; growthMult: number;
  maturityMult: number; chainMult: number; catMult: number; age: number | null;
}

// The model's one scoring function: TVL x category x growth x maturity x chains.
function impliedValue(p: Protocol, asOf: string): Scored {
  const age = ageDays(asOf, p.listed_at);
  const rawGrowth = typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : 0;
  const growthPct = Math.min(MODEL.growthCap, Math.max(MODEL.growthFloor, rawGrowth));
  const growthMult = 1 + (growthPct / 100) * MODEL.growthWeight;
  const ageForModel = age ?? MODEL.unknownAgeDays;
  const maturityMult = MODEL.maturityFloor
    + (Math.min(Math.max(ageForModel, 0), MODEL.maturityDays) / MODEL.maturityDays) * MODEL.maturityRange;
  const chainCount = Math.max(0, Math.min(p.chains.length - 1, MODEL.chainMax));
  const chainMult = 1 + chainCount * MODEL.chainStep;
  const catMult = categoryMultiple(p.category);
  const implied = Math.max(1, Math.round(p.tvl_usd * catMult * growthMult * maturityMult * chainMult));
  return { implied, growthPct, growthMult, maturityMult, chainMult, catMult, age };
}

function round4(n: number): number { return Math.round(n * 1e4) / 1e4; }

// A protocol records no token when DefiLlama carries no market cap, no
// CoinGecko id and no symbol for it. "No token on record" is not proof it
// has none; the board says so on the page.
function isPreToken(p: Protocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

// Rankable: pre-token, not an exchange, not a versioned pool of another app.
function isRankable(p: Protocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new Error('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new Error('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new Error('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new Error('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new Error('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new Error('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`snapshot.json protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new Error(`snapshot.json protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug, name: p.name,
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
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

// ---- farm plans: every step is derived from the protocol's own record ----

function chainOf(p: Protocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

// Capital scales with the protocol's TVL tier: bigger protocol, bigger
// position, because a $50 position in a $5B pool is noise.
function capitalFor(p: Protocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 300;
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 100_000_000) return 120;
  return 60;
}

// Hold longer when the protocol is young: a short history needs more weeks
// of activity to look real in a snapshot.
function holdDaysFor(age: number | null): number {
  if (age === null) return 60;
  if (age < 180) return 90;
  if (age < 365) return 60;
  return 45;
}

// Gas is chain-priced: Ethereum mainnet costs real money, L2s and cheap L1s do not.
function gasFor(chain: string): { setup: number; weekly: number } {
  if (chain.toLowerCase() === 'ethereum') return { setup: 12, weekly: 4 };
  return { setup: 2, weekly: 1 };
}

// The one action that fits the protocol's category, in words a farmer can follow.
function actionFor(p: Protocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the lending position open.`;
  if (c.includes('dex') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the LP position open.`;
  if (c.includes('yield aggregator') || c.includes('yield')) return `Deposit $${capital} of USDC into ${name}'s highest-TVL vault on ${chain} and keep the shares.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} on ${chain} and keep the receipt token.`;
  if (c.includes('perpetual') || c.includes('derivative') || c.includes('options')) return `Deposit $${capital} of USDC as margin on ${name} on ${chain} and open one small hedged trade.`;
  if (c.includes('prediction')) return `Fund $${capital} on ${name} and place one small position in an active market.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the vault shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain} and hold it.`;
  if (c.includes('rwa')) return `Mint $${capital} of the yield-bearing asset on ${name} (${chain}) and hold it to maturity.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('payment')) return `Route $${capital} of payments through ${name} on ${chain} over the next month.`;
  if (c.includes('governance')) return `Lock $${capital} of assets in ${name}'s incentive pool on ${chain} and vote once a week.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

// The second leg: a different action on the same protocol, so the wallet
// shows breadth, not one click. Cross-chain when the protocol runs on two
// or more chains, a second product when it runs on one.
function secondLeg(p: Protocol, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  if (p.chains.length > 1) {
    const second = p.chains[1]!;
    return `Repeat a smaller $25 position on ${second} so the wallet shows activity on two chains, not one.`;
  }
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Borrow $20 against the deposit and repay it a week later, so the wallet shows both sides of ${p.name}.`;
  if (c.includes('dex') || c.includes('yield')) return `Stake the LP or vault receipt for another week instead of leaving it idle, if ${p.name} offers staking.`;
  if (c.includes('staking') || c.includes('restak')) return `Delegate a second $25 stake to a different validator or pool inside ${p.name}.`;
  return `Use one more feature of ${p.name} on ${chain} — a swap, a vote or a second pool — with $25.`;
}

interface Step { text: string; cost: string; time: string; }

function stepText(step: Step): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

// Seven steps, each with a cost and a time, all computed from this protocol.
function farmSteps(p: Protocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = gasFor(chain);
  const weeks = Math.max(1, Math.round(hold / 7));
  const weeklyGas = gas.weekly * weeks;
  const steps: Step[] = [
    {
      text: `Open a fresh wallet that holds only farming funds, write its seed phrase on paper, and fund it with $${capital + gas.setup} on ${chain}.`,
      cost: `about $${gas.setup} of gas for the first transactions`,
      time: '10 minutes to set up',
    },
    { text: actionFor(p, capital, chain), cost: `$${capital} of capital and about $${gas.setup} of gas`, time: '15 minutes to set up' },
    { text: secondLeg(p, chain), cost: '$25 of capital and about $2 of gas', time: '15 minutes' },
    {
      text: `Do one qualifying action every week for ${weeks} weeks — a deposit, a swap, a vote or a claim — and never leave the wallet idle for a whole month.`,
      cost: `about $${weeklyGas} of gas over ${weeks} weeks`,
      time: '10 minutes a week',
    },
    {
      text: `Hold the main position for at least ${hold} days so the activity is counted in more than one snapshot window.`,
      cost: `the $${capital} stays locked in the position`,
      time: `${hold} days`,
    },
    {
      text: `Once a month, open ${p.name}'s own points or rewards page from its official site and check the balance; claim only from a link the protocol itself publishes.`,
      cost: 'nothing to check, and never pay anyone to claim for you',
      time: '10 minutes a month',
    },
    {
      text: `Keep a farm log — wallet, dates, every transaction hash — and plan the exit now: unwind in two steps, revoke token approvals, and move funds back to the main wallet.`,
      cost: 'about $3 of gas to unwind',
      time: '10 minutes to log and exit',
    },
  ];
  return steps.map(stepText);
}

// ---- board ----

interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  gecko_id: string | null; symbol: string | null; token_status: 'pre-token';
  age_days: number | null; implied_value_usd: number;
  model: { base_multiple: number; growth_pct: number; growth_multiplier: number; maturity_multiplier: number; chain_multiplier: number; age_days: number | null };
  farm_steps: string[];
}

function buildBoard(snapshot: Snapshot): BoardRow[] {
  const index = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  const chosen = new Map<string, Protocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // Early radar: pre-token protocols below the floor, by TVL, capped.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, s: impliedValue(p, snapshot.as_of) }));
  scored.sort((a, b) => b.s.implied - a.s.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((x, i) => ({
    rank: i + 1, slug: x.p.slug, name: x.p.name, category: x.p.category, chains: x.p.chains,
    tvl_usd: x.p.tvl_usd, change_7d: x.p.change_7d, mcap_usd: x.p.mcap_usd, listed_at: x.p.listed_at,
    gecko_id: x.p.gecko_id, symbol: x.p.symbol, token_status: 'pre-token' as const,
    age_days: x.s.age, implied_value_usd: x.s.implied,
    model: {
      base_multiple: x.s.catMult, growth_pct: x.s.growthPct,
      growth_multiplier: round4(x.s.growthMult), maturity_multiplier: round4(x.s.maturityMult),
      chain_multiplier: round4(x.s.chainMult), age_days: x.s.age,
    },
    farm_steps: farmSteps(x.p, x.s.age),
  }));
}

// Live-token protocols, set aside from the ranking: their market cap is a
// fact, not a model, so the page shows them in their own tab.
function liveRows(snapshot: Snapshot) {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  if (board.length < 100) return `the board has ${board.length} rows, fewer than 100`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) return 'all rows share the same implied value';
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) return `${r.slug} has implied value ${r.implied_value_usd}`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  return null;
}

function dataScript(snapshot: Snapshot, board: BoardRow[]): string {
  const radar = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model: MODEL, model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length, board_size: board.length,
    early_size: board.filter((r) => !snapshot.watchlist.includes(r.slug)).length,
    live_size: LIVE_ROWS,
    rows: board.map((r) => ({
      rank: r.rank, slug: r.slug, name: r.name, category: r.category, chains: r.chains,
      tvl_usd: r.tvl_usd, change_7d: r.change_7d, listed_at: r.listed_at, age_days: r.age_days,
      implied_value_usd: r.implied_value_usd, watchlist: snapshot.watchlist.includes(r.slug),
      model: r.model, farm_steps: r.farm_steps,
    })),
    live: liveRows(snapshot),
  };
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}

// ---- entry point ----

function arg(name: string, fallback: string): string {
  const at = process.argv.indexOf(`--${name}`);
  if (at >= 0 && at + 1 < process.argv.length) return process.argv[at + 1]!;
  const withEquals = process.argv.find((a) => a.startsWith(`--${name}=`));
  return withEquals === undefined ? fallback : withEquals.slice(name.length + 3);
}

const inputArg = arg('input', '/input');
const inputFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(inputFile)) {
  process.stderr.write(`token radar: no snapshot at ${inputFile}: pass --input <snapshot.json|directory>\n`);
  process.exit(2);
}
const out = arg('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const snapshot = parseSnapshot(readFileSync(inputFile, 'utf8'));
const board = buildBoard(snapshot);
const issue = boardIssue(board, snapshot);
if (issue !== null) {
  process.stderr.write(`token radar: the model wrote a board the gate refuses: ${issue}\n`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(out, 'data.js'), dataScript(snapshot, board));

function copyFiles(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const path = join(from, name);
    if (!statSync(path).isFile()) continue;
    copyFileSync(path, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyFiles(join(here, 'dashboard'), join(out, 'dashboard'));
const shots = copyFiles(join(here, 'screenshots'), join(out, 'screenshots'));
if (shots.length < 3) {
  process.stderr.write(`token radar: screenshots/ holds ${shots.length} images: hand in 3, the board, a detail view and a filtered view\n`);
  process.exit(1);
}
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
for (const name of shots) {
  if (!IMAGE_NAME.test(name)) {
    process.stderr.write(`token radar: screenshots/${name}: a name is letters, digits and . _ -\n`);
    process.exit(1);
  }
}

writeFileSync(join(out, 'dossier.json'), buildDossier(out, { text_max_bytes: TEXT_MAX_BYTES, screenshots: { max: 4, max_bytes: 524_288 }, dashboard: { max_files: 400, max_bytes: 4_194_304 } }));

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored\n` +
    `token radar: wrote ${join(out, 'board.json')}, ${join(out, 'data.js')}, ${join(out, 'dashboard')}, ${join(out, 'screenshots')} (${shots.length} images) and ${join(out, 'dossier.json')}\n`,
);

