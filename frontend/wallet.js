// Address + memecoin + backend integration. No wallet connection required —
// players just paste the address they want rewards sent to. This is exactly
// as safe as before: the reward flow never asked for a signature anyway (the
// backend pays gas and sends the transaction itself), so typing an address
// gives up nothing a "Connect Wallet" button would have protected.
//
// Depends on ethers.js (CDN), config.js, and abis.js loaded first — but
// everything below touches `ethers` lazily (inside functions, not at script
// load time), so a slow or blocked CDN degrades gracefully: the player can
// still set their address and play, they just won't see a live balance until
// ethers is available.

const ERC20_MIN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

// Simple 0x + 40 hex chars check — used as a fallback so address entry keeps
// working even if ethers.js hasn't loaded (checksum validation needs ethers,
// but basic shape validation doesn't).
const ADDRESS_SHAPE = /^0x[a-fA-F0-9]{40}$/;

const Wallet = (() => {
  let address = null;
  let tokenDecimals = 18;
  let tokenSymbol = CONFIG.MEMECOIN_SYMBOL;
  let currentSessionId = null;

  let provider = null;
  let rewardsContract = null;
  let tokenContract = null;
  let metaFetchStarted = false;

  try {
    const saved = localStorage.getItem("hoodie_run_address");
    if (saved && ADDRESS_SHAPE.test(saved)) address = saved;
  } catch {
    // ignore — just start with no saved address
  }

  // Lazily builds the read-only chain connection the first time it's
  // actually needed, so a missing/slow ethers.js doesn't break page load.
  function ensureChainAccess() {
    if (provider) return true;
    if (typeof ethers === "undefined") return false;
    try {
      provider = new ethers.JsonRpcProvider(CONFIG.NETWORK.rpcUrls[0]);
      rewardsContract = new ethers.Contract(CONFIG.GAME_REWARDS_ADDRESS, GAME_REWARDS_ABI, provider);
      tokenContract = new ethers.Contract(CONFIG.MEMECOIN_ADDRESS, ERC20_MIN_ABI, provider);
      return true;
    } catch {
      return false;
    }
  }

  // Fetches the token's real symbol/decimals once chain access is available.
  // Safe to call repeatedly — only does real work once.
  function ensureTokenMeta() {
    if (metaFetchStarted) return;
    if (!ensureChainAccess()) return;
    metaFetchStarted = true;
    Promise.all([tokenContract.decimals(), tokenContract.symbol()])
      .then(([d, s]) => {
        tokenDecimals = d;
        tokenSymbol = s;
      })
      .catch(() => {
        metaFetchStarted = false; // allow a retry later if this failed
      });
  }
  ensureTokenMeta();

  // Cached reward-rate params, read from the contract itself so the UI's
  // live projection always matches whatever the contract is actually
  // configured to pay — not a hardcoded guess.
  let rewardParams = null; // { rewardPerPoint: bigint, maxRewardPerClaim: bigint }
  let rewardParamsFetchStarted = false;

  function getRewardParams() {
    if (rewardParams) return Promise.resolve(rewardParams);
    if (rewardParamsFetchStarted || !ensureChainAccess()) return Promise.resolve(null);
    rewardParamsFetchStarted = true;
    return Promise.all([rewardsContract.rewardPerPoint(), rewardsContract.maxRewardPerClaim()])
      .then(([perPoint, maxClaim]) => {
        rewardParams = { rewardPerPoint: perPoint, maxRewardPerClaim: maxClaim };
        return rewardParams;
      })
      .catch(() => {
        rewardParamsFetchStarted = false;
        return null;
      });
  }

  // Given a live in-progress score, estimates what the player would receive
  // if the run ended right now — same math as the contract (per-point rate,
  // capped at the per-claim max), formatted for display. Returns "0" if the
  // reward params haven't loaded yet (e.g. ethers still loading).
  function estimateReward(score) {
    if (!rewardParams || !score) return "0";
    let raw = BigInt(Math.floor(score)) * rewardParams.rewardPerPoint;
    if (raw > rewardParams.maxRewardPerClaim) raw = rewardParams.maxRewardPerClaim;
    try {
      return ethers.formatUnits(raw, tokenDecimals);
    } catch {
      return "0";
    }
  }
  getRewardParams();

  const listeners = { change: [] };
  function emitChange() {
    listeners.change.forEach((fn) => fn(getState()));
  }
  function onChange(fn) {
    listeners.change.push(fn);
  }
  function getState() {
    return { connected: !!address, address };
  }

  // Validates and saves the address the player typed in. Returns an error
  // message on failure, or null on success.
  function setAddress(input) {
    const trimmed = (input || "").trim();
    if (!ADDRESS_SHAPE.test(trimmed)) {
      return "That doesn't look like a valid address — double check it starts with 0x and is 42 characters long.";
    }
    // Normalize to checksum casing when ethers is available; otherwise keep
    // it as-is (still a perfectly valid address, just not re-cased).
    address = ensureChainAccess() ? ethers.getAddress(trimmed) : trimmed;
    try {
      localStorage.setItem("hoodie_run_address", address);
    } catch {
      // ignore — still works for this session even if storage fails
    }
    ensureTokenMeta();
    emitChange();
    return null;
  }

  function clearAddress() {
    address = null;
    try {
      localStorage.removeItem("hoodie_run_address");
    } catch {
      // ignore
    }
    emitChange();
  }

  async function tokenBalance() {
    if (!address || !ensureChainAccess()) return { formatted: "0", symbol: tokenSymbol };
    try {
      const bal = await tokenContract.balanceOf(address);
      return { formatted: ethers.formatUnits(bal, tokenDecimals), symbol: tokenSymbol };
    } catch {
      return { formatted: "0", symbol: tokenSymbol };
    }
  }

  async function playerStats() {
    if (!address || !ensureChainAccess()) return { bestScore: 0, totalEarned: "0" };
    try {
      const [best, earned] = await Promise.all([
        rewardsContract.bestScore(address),
        rewardsContract.totalEarned(address),
      ]);
      return { bestScore: Number(best), totalEarned: ethers.formatUnits(earned, tokenDecimals) };
    } catch {
      return { bestScore: 0, totalEarned: "0" };
    }
  }

  // Called when a run starts, so the backend can time it server-side.
  async function startRunSession() {
    if (!address) {
      currentSessionId = null;
      return null;
    }
    const res = await fetch(`${CONFIG.BACKEND_URL}/api/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ player: address }),
    });
    currentSessionId = res.ok ? (await res.json()).sessionId : null;
    return currentSessionId;
  }

  // Called on game over. The backend validates the run and — if it's above
  // the reward threshold — queues it for the next (short) batch payout. The
  // backend pays gas and sends the tokens itself; pollRewardStatus() below
  // is how the UI finds out the moment it actually lands.
  async function submitRun(score) {
    if (!address) return { status: "no-wallet" };
    if (!currentSessionId) return { status: "no-session" };

    const sessionId = currentSessionId;
    currentSessionId = null;

    const res = await fetch(`${CONFIG.BACKEND_URL}/api/session/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId, player: address, score }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      return { status: "rejected", message: err.error || "Backend rejected the score" };
    }
    const data = await res.json();
    if (!data.queued) {
      return { status: "below-threshold", score: data.score };
    }
    return { status: "queued", score: data.score, sessionId, etaSeconds: data.etaSeconds };
  }

  // Polls the backend until a queued reward has been sent (or we give up).
  // Calls onUpdate(status) each time it checks so the UI can reflect it.
  async function pollRewardStatus(sessionId, onUpdate, { intervalMs = 2000, timeoutMs = 5 * 60 * 1000 } = {}) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      await new Promise((r) => setTimeout(r, intervalMs));
      try {
        const res = await fetch(`${CONFIG.BACKEND_URL}/api/session/status/${sessionId}`);
        if (!res.ok) continue;
        const data = await res.json();
        onUpdate(data);
        if (data.status === "sent" || data.status === "failed") return data;
      } catch {
        // transient fetch error — just try again next tick
      }
    }
    return { status: "timeout" };
  }

  return {
    setAddress,
    clearAddress,
    onChange,
    getState,
    tokenBalance,
    playerStats,
    startRunSession,
    submitRun,
    pollRewardStatus,
    getRewardParams,
    estimateReward,
    get tokenSymbol() {
      return tokenSymbol;
    },
  };
})();
