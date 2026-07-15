# Hoodie Run — an awareness/reward dapp for $HOODIE

A Chrome-dino-style endless runner where players paste the wallet address
they want rewards sent to (no wallet connection or signature required),
dodge invading monsters, and automatically receive $HOODIE — no claim
button, no gas — for a good run. Built to double as a marketing/awareness
tool for the token.

```
frontend/   canvas game + address-paste UI (plain HTML/JS, no build step)
contracts/  GameRewards.sol — pays out an existing ERC-20 from a reserve
backend/    Node/Express service that validates a run and auto-distributes
scripts/    Hardhat deploy script
```

## Why no wallet connection

Players just type/paste the address they want $HOODIE sent to — there's no
"Connect Wallet" popup, no signature request, no permissions granted to the
site. This isn't a security downgrade: the reward flow never asked for a
signature anyway (the backend pays gas and sends the transaction itself —
see below), so a wallet-connect button was only ever a way to *read* the
player's address, and a text input does that with far less friction and
zero of the trust hesitation a lot of people reasonably have about
connecting a wallet to an unfamiliar site.

The address is saved in the browser's local storage so returning players
don't have to retype it. The frontend also uses a plain read-only RPC
connection to show the player's live $HOODIE balance and best score —
again, no wallet extension required for that either.

## The token and chain

This is wired to **$HOODIE**
(`0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3`), which lives on
**Robinhood Chain** (Robinhood's Arbitrum-Orbit L2, chainId `4663`) — not
Ethereum mainnet. The RPC config and contract deployment are all pointed at
Robinhood Chain. If you ever swap in a different memecoin, double check
which chain *it* actually lives on before reusing this config — Ethereum
mainnet and Base configs are kept in `hardhat.config.js` / commented in
`frontend/config.js` for reference.

Robinhood Chain being an L2 also matters for cost: gas is paid in ETH but
is far cheaper than Ethereum mainnet, which is what makes fully-automatic,
backend-paid distribution practical here.

## Why there's a backend at all

The game runs entirely in the player's browser, so a raw "score: 999999"
can't be trusted on its own. Instead of asking the player to submit a signed
claim themselves, the backend does the trust work — and pays the gas itself,
in short batches:

1. When a run **starts**, the frontend calls the backend, which timestamps a
   session server-side.
2. When the run **ends**, the frontend sends the final score. The backend
   checks it's plausible for the elapsed wall-clock time (a generous
   points-per-second cap), and skips the reward entirely below a minimum
   score (saves gas on trivial runs).
3. If it passes, the run is **queued** rather than paid out immediately.
4. Every `BATCH_INTERVAL_MS` (**15 seconds by default** — tuned for a
   near-instant feel), the backend flushes the whole queue in one call to
   `GameRewards.distributeBatch(players, scores)` — one transaction, one gas
   bill, however many players are in it (up to `MAX_BATCH_SIZE`). $HOODIE
   lands in every included player's wallet at once. Nothing for any player
   to sign or click either way.
5. The frontend polls `/api/session/status/:sessionId` every couple of
   seconds after queuing so it can tell the player the moment their batch
   actually sends.

Batching still trades a small delay for lower gas cost per player, but at a
15-second window that delay is barely noticeable — most players will see
their reward land within moments of finishing a run, while runs that happen
to land in the same 15-second window still only cost one transaction
combined. Raise `BATCH_INTERVAL_MS` if gas costs start to matter more to you
than payout speed (see the tuning note further down); lower it toward `0` if
you'd rather skip batching almost entirely.

The trust boundary is the backend's `DISTRIBUTOR_PRIVATE_KEY`. Whoever holds
it can trigger payouts, so: fund it with gas money only (it never holds
$HOODIE — the `GameRewards` contract holds the reserve), rotate it via
`setDistributor()` if it's ever suspected compromised, and rely on the
per-address cooldown + per-claim cap in the contract to bound the damage of
any single bad call.

## 1. Install dependencies

```bash
npm install
cd backend && npm install && cd ..
```

## 2. Deploy the rewards contract

Copy `.env.example` → `.env` in the project root. `MEMECOIN_ADDRESS` is
already filled in with HOODIE's address; you still need:

```
DEPLOYER_PRIVATE_KEY=0x...      # wallet that deploys + owns the contract
DISTRIBUTOR_ADDRESS=0x...       # a SEPARATE wallet, see below
```

Generate a fresh distributor key just for this (never reuse an existing
wallet — it's going to be signing/sending transactions constantly):

```bash
node -e "const w = require('ethers').Wallet.createRandom(); console.log('address:', w.address); console.log('privateKey:', w.privateKey)"
```

Bridge a small amount of ETH to your deployer wallet on Robinhood Chain (via
the canonical Arbitrum bridge — see the Robinhood Chain docs), then deploy:

```bash
npm run deploy:robinhood
```

This prints the deployed `GameRewards` address and next steps. You'll need
to:

- Send some $HOODIE to that address (it's the reward reserve).
- Call `setRewardParams(rewardPerPoint, maxRewardPerClaim)` with the right
  scaling for HOODIE's actual decimals (check on Blockscout — defaults
  assume 18).
- Send a small amount of ETH to the distributor wallet for gas.

> Note: `npx hardhat compile` needs to reach `binaries.soliditylang.org` to
> download the Solidity compiler. If your network blocks that, run
> `node compile-check.js` instead (included here) — it compiles with the
> same solc version via the npm-distributed `solc` package and writes
> `abis.json`, which `frontend/abis.js` is generated from.

## 3. Configure and run the backend

```bash
cd backend
cp .env.example .env
# fill in REWARDS_CONTRACT_ADDRESS and DISTRIBUTOR_PRIVATE_KEY
npm start
```

Listens on `http://localhost:4000` by default. `MIN_SCORE_FOR_REWARD` (env
var, default 30) controls the gas-saving cutoff below which a run isn't
queued at all. `BATCH_INTERVAL_MS` (default 3 minutes) controls how often
the queue is flushed into a single `distributeBatch` transaction.

## 4. Configure and run the frontend

Edit `frontend/config.js` and set `GAME_REWARDS_ADDRESS` to the address from
step 2 (`MEMECOIN_ADDRESS` and the Robinhood Chain network block are already
set). Then serve the static files:

```bash
cd frontend
npx serve .
```

Open it with a Robinhood-Chain-aware wallet (MetaMask works — the game
prompts it to add/switch to Robinhood Chain automatically if needed).

## Awareness features

- **Auto-share** — after a run, a "Share your score" button opens a tweet
  intent (or the native share sheet on mobile) pre-filled with the score and
  ticker.
- **Leaderboard** — the backend keeps a simple top-20 list
  (`backend/leaderboard.json`) of the best scores it has distributed
  rewards for, shown on the page. Swap the flat-file store for a real DB if
  you expect real traffic.

## Reward economics (tune to taste)

Current defaults in `contracts/GameRewards.sol`:

- `rewardPerPoint` = **1 full $HOODIE per point** (`1 ether` in Solidity
  terms — assumes an 18-decimal token; double check HOODIE's actual
  decimals on Blockscout and adjust via `setRewardParams` if it differs).
- `maxRewardPerClaim` = **50,000 $HOODIE** per single distribution — a
  10,000-point run (very achievable given the scoring rate) already hits
  this cap, so at 1 token/point the cap is the main lever on how much a
  single run can pay out. Given scores can climb into the tens of thousands
  within a few minutes of play, sanity-check this against how large a
  reserve you're comfortable funding before going live — this rate is
  extremely generous relative to HOODIE's current market price, so it's
  worth deciding intentionally rather than assuming the numbers "feel small"
  just because each unit is "1 point = 1 token."
- `claimCooldown` — minimum time between payouts per address (also bounds
  how often the backend pays gas for one address).
- `MAX_BATCH_SIZE` (constant, 150) — hard ceiling on players per
  `distributeBatch` call, so one batch can't grow large enough to risk a
  block gas limit.

The frontend HUD's "If you stopped now" stat mirrors this exact math live,
client-side, as the score climbs during a run (`Wallet.estimateReward()` in
`wallet.js`, reading `rewardPerPoint`/`maxRewardPerClaim` straight from the
contract so it never drifts out of sync with whatever's actually configured
on-chain). It's a projection only — the real payout is still decided by the
backend + contract when the run ends and the batch flushes.

In `backend/server.js`:

- `MIN_SCORE_FOR_REWARD` — skip queuing (and its eventual gas cost)
  entirely below this score.
- `BATCH_INTERVAL_MS` — how often the queue is flushed into one
  `distributeBatch` transaction. Bigger interval = fewer, cheaper
  transactions, but players wait longer to see the reward land.
- `MAX_BATCH_SIZE` — max players paid per flush (must stay ≤ the contract's
  `MAX_BATCH_SIZE`). If more than this are queued when the interval fires,
  the rest wait for the next flush.
- `MAX_POINTS_PER_SECOND` — anti-cheat plausibility cap; tune if you change
  the scoring formula in `frontend/game.js`.

## Before scaling this up

- Get the contract audited — this is a reference implementation, not an
  audited production contract, and it's now moving a real, trading token.
- The backend's in-memory session store and flat-file leaderboard are fine
  for a demo; move to Redis/a real DB if you expect meaningful traffic or
  run multiple backend instances.
- Watch the distributor wallet's ETH balance — if it runs dry, distribution
  calls will simply fail (a monitoring/alert on its balance is worth
  setting up before any real launch/marketing push).
- Consider a rate limit or CAPTCHA-style check on `/api/session/start` if
  this gets popular — right now it's just a per-address time gate.
# hoodie-run
