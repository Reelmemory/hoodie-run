require("dotenv").config();
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 4000;
const RPC_URL = process.env.RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
const REWARDS_CONTRACT_ADDRESS = process.env.REWARDS_CONTRACT_ADDRESS;
const DISTRIBUTOR_PRIVATE_KEY = process.env.DISTRIBUTOR_PRIVATE_KEY;

// Skip queuing entirely below this score, to save gas on trivial runs.
const MIN_SCORE_FOR_REWARD = Number(process.env.MIN_SCORE_FOR_REWARD || 30);

// How often the batch job flushes the queue, and how many players it'll
// pay out in one transaction. Longer interval / bigger batches = fewer,
// cheaper transactions, but players wait longer to see the reward land.
// Must stay <= the contract's MAX_BATCH_SIZE (150).
const BATCH_INTERVAL_MS = Number(process.env.BATCH_INTERVAL_MS || 15 * 1000);
const MAX_BATCH_SIZE = Number(process.env.MAX_BATCH_SIZE || 100);

const LEADERBOARD_FILE = path.join(__dirname, "leaderboard.json");
const LEADERBOARD_SIZE = 20;

if (!REWARDS_CONTRACT_ADDRESS || !DISTRIBUTOR_PRIVATE_KEY) {
  console.warn(
    "⚠️  REWARDS_CONTRACT_ADDRESS / DISTRIBUTOR_PRIVATE_KEY not set. " +
      "Copy backend/.env.example to backend/.env and fill it in after deploying the contract."
  );
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const distributorWallet = DISTRIBUTOR_PRIVATE_KEY ? new ethers.Wallet(DISTRIBUTOR_PRIVATE_KEY, provider) : null;

const REWARDS_ABI = [
  "function distributeReward(address player, uint256 score) returns (uint256)",
  "function distributeBatch(address[] players, uint256[] scores) returns (uint256[])",
];
const rewardsContract =
  REWARDS_CONTRACT_ADDRESS && ethers.isAddress(REWARDS_CONTRACT_ADDRESS) && distributorWallet
    ? new ethers.Contract(REWARDS_CONTRACT_ADDRESS, REWARDS_ABI, distributorWallet)
    : null;

// ---- Serialize on-chain sends so overlapping batches don't collide on nonce ----
let txQueue = Promise.resolve();
function sendTx(fn) {
  const result = txQueue.then(fn, fn); // run even if a prior queued tx failed
  txQueue = result.then(
    () => {},
    () => {}
  );
  return result;
}

// ---- Sessions (run timing, for anti-cheat) ----
const sessions = new Map(); // sessionId -> { player, startTime, used }
const lastSessionByPlayer = new Map();

const SESSION_TTL_MS = 5 * 60 * 1000;
const MIN_SESSION_INTERVAL_MS = 2000;
// Mirrors the exact difficulty ramp + scoring formula in frontend/game.js,
// so the anti-cheat check is tied to reality instead of a guessed flat rate.
// A generous multiplicative grace margin covers timing/lag jitter between
// this fixed-step simulation and a real browser's variable frame times.
function maxPlausibleScore(elapsedMs) {
  let distance = 0,
    score = 0;
  const dt = 16;
  for (let t = 0; t < elapsedMs; t += dt) {
    const speed = Math.min(1.15, 0.32 + distance / 260000);
    distance += speed * dt;
    score += speed * dt * 0.12;
  }
  const GRACE_MULTIPLIER = 1.25;
  const FLAT_GRACE = 30;
  return Math.ceil(score * GRACE_MULTIPLIER) + FLAT_GRACE;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.startTime > SESSION_TTL_MS) sessions.delete(id);
  }
}

// ---- Reward queue + status tracking ----
// Each entry: { sessionId, player, score, queuedAt }
let pendingQueue = [];
// sessionId -> { status: 'queued' | 'sent' | 'failed', score, txHash? }
const rewardStatus = new Map();

function queueReward(sessionId, player, score) {
  pendingQueue.push({ sessionId, player, score, queuedAt: Date.now() });
  rewardStatus.set(sessionId, { status: "queued", score });
}

async function flushBatch() {
  if (pendingQueue.length === 0 || !rewardsContract) return;

  const batch = pendingQueue.slice(0, MAX_BATCH_SIZE);
  pendingQueue = pendingQueue.slice(batch.length);

  const players = batch.map((b) => b.player);
  const scores = batch.map((b) => b.score);

  try {
    const txHash = await sendTx(async () => {
      const tx = await rewardsContract.distributeBatch(players, scores);
      const receipt = await tx.wait();
      return receipt.hash;
    });

    for (const entry of batch) {
      rewardStatus.set(entry.sessionId, { status: "sent", score: entry.score, txHash });
      recordScore(entry.player, entry.score, txHash);
    }
    console.log(`Batch sent: ${batch.length} players, tx ${txHash}`);
  } catch (err) {
    console.error("Batch distribution failed, re-queuing for next interval:", err.message || err);
    for (const entry of batch) {
      rewardStatus.set(entry.sessionId, { status: "queued", score: entry.score });
    }
    // put failed batch back at the front so it's retried next tick
    pendingQueue = [...batch, ...pendingQueue];
  }
}

setInterval(flushBatch, BATCH_INTERVAL_MS);

// ---- Leaderboard persistence (flat JSON file — swap for a DB at scale) ----
function loadLeaderboard() {
  try {
    return JSON.parse(fs.readFileSync(LEADERBOARD_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveLeaderboard(list) {
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(list, null, 2));
}
function recordScore(player, score, txHash) {
  const list = loadLeaderboard();
  list.push({ player, score, txHash, at: Date.now() });
  list.sort((a, b) => b.score - a.score);
  const trimmed = list.slice(0, LEADERBOARD_SIZE);
  saveLeaderboard(trimmed);
  return trimmed;
}

app.post("/api/session/start", (req, res) => {
  cleanupSessions();
  const { player } = req.body;
  if (!player || !ethers.isAddress(player)) {
    return res.status(400).json({ error: "Valid player address required" });
  }

  const now = Date.now();
  const last = lastSessionByPlayer.get(player.toLowerCase());
  if (last && now - last < MIN_SESSION_INTERVAL_MS) {
    return res.status(429).json({ error: "Starting sessions too quickly" });
  }
  lastSessionByPlayer.set(player.toLowerCase(), now);

  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { player: player.toLowerCase(), startTime: now, used: false });
  res.json({ sessionId });
});

app.post("/api/session/submit", async (req, res) => {
  try {
    const { sessionId, player, score } = req.body;
    if (!sessionId || !player || typeof score !== "number") {
      return res.status(400).json({ error: "sessionId, player, and numeric score are required" });
    }
    if (!ethers.isAddress(player)) {
      return res.status(400).json({ error: "Invalid player address" });
    }
    if (!Number.isInteger(score) || score <= 0 || score > 1_000_000) {
      return res.status(400).json({ error: "Score out of plausible range" });
    }

    const session = sessions.get(sessionId);
    if (!session) return res.status(400).json({ error: "Unknown or expired session" });
    if (session.used) return res.status(400).json({ error: "Session already claimed" });
    if (session.player !== player.toLowerCase()) {
      return res.status(400).json({ error: "Session does not belong to this player" });
    }

    const elapsedMs = Date.now() - session.startTime;
    const maxAllowed = maxPlausibleScore(elapsedMs);
    if (score > maxAllowed) {
      return res.status(400).json({
        error: `Score implausible for elapsed time (${elapsedMs}ms). Max allowed: ${maxAllowed}`,
      });
    }

    session.used = true;

    if (score < MIN_SCORE_FOR_REWARD) {
      return res.json({ queued: false, reason: "below-reward-threshold", score });
    }

    if (!rewardsContract) {
      return res.status(500).json({ error: "Backend not configured with contract/distributor key yet" });
    }

    queueReward(sessionId, player, score);
    res.json({
      queued: true,
      score,
      etaSeconds: Math.round(BATCH_INTERVAL_MS / 1000),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal error queuing reward" });
  }
});

// Frontend polls this after a run to find out when the batched reward lands.
app.get("/api/session/status/:sessionId", (req, res) => {
  const status = rewardStatus.get(req.params.sessionId);
  if (!status) return res.status(404).json({ error: "Unknown session" });
  res.json(status);
});

app.get("/api/leaderboard", (req, res) => {
  res.json({ leaderboard: loadLeaderboard() });
});

app.get("/api/health", (req, res) => res.json({ ok: true, pendingInQueue: pendingQueue.length }));

app.listen(PORT, () => {
  console.log(
    `Hoodie Run backend listening on http://localhost:${PORT} — batching every ${BATCH_INTERVAL_MS / 1000}s`
  );
});