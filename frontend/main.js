const els = {
  muteBtn: document.getElementById("mute-btn"),
  addressInput: document.getElementById("address-input"),
  addressMsg: document.getElementById("address-msg"),
  balance: document.getElementById("token-balance"),
  balanceSymbol: document.getElementById("balance-symbol"),
  score: document.getElementById("score"),
  best: document.getElementById("best-score"),
  duckBtn: document.getElementById("duck-btn"),
  leaderboardList: document.getElementById("leaderboard-list"),
  modal: document.getElementById("reward-modal"),
  modalScore: document.getElementById("modal-score"),
  modalMsg: document.getElementById("modal-msg"),
  shareBtn: document.getElementById("share-btn"),
  claimBtn: document.getElementById("claim-btn"),
  modalCloseBtn: document.getElementById("modal-close-btn"),
};

let lastScore = 0;
let bestScore = Number(localStorage.getItem("hoodie_run_best_score") || 0);
els.best.textContent = bestScore;

function shortAddr(a) {
  return `${a.slice(0, 6)}...${a.slice(-4)}`;
}

// ---- Persistent address bar (always visible, no toggle/save button —
// saves automatically when you finish typing) ----
function refreshAddressUI() {
  const s = Wallet.getState();
  els.balanceSymbol.textContent = Wallet.tokenSymbol;
  els.balance.textContent = "0.00";
  if (s.connected) {
    if (document.activeElement !== els.addressInput) els.addressInput.value = s.address;
    els.addressMsg.textContent = `Rewards go to ${shortAddr(s.address)}.`;
    els.addressMsg.classList.remove("error");
    els.addressMsg.classList.add("success");
  } else {
    els.addressMsg.textContent = "";
    els.addressMsg.classList.remove("error", "success");
  }
}

Wallet.onChange(refreshAddressUI);

// Prefill from any previously-saved address on load.
const existing = Wallet.getState();
if (existing.connected) els.addressInput.value = existing.address;

function trySaveAddress() {
  const value = els.addressInput.value.trim();
  if (!value) {
    els.addressMsg.textContent = "";
    els.addressMsg.classList.remove("error", "success");
    return;
  }
  const err = Wallet.setAddress(value);
  if (err) {
    els.addressMsg.textContent = err;
    els.addressMsg.classList.remove("success");
    els.addressMsg.classList.add("error");
  }
}

els.addressInput.addEventListener("blur", trySaveAddress);
els.addressInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.addressInput.blur(); // triggers trySaveAddress via blur
});

// Also save shortly after typing stops, so a run started right after typing
// (before the field ever loses focus) still has the address on file.
let saveDebounceTimer = null;
els.addressInput.addEventListener("input", () => {
  clearTimeout(saveDebounceTimer);
  saveDebounceTimer = setTimeout(trySaveAddress, 500);
});

function updateMuteIcon() {
  els.muteBtn.textContent = Sound.isMuted() ? "🔇" : "🔊";
}
updateMuteIcon();

els.muteBtn.addEventListener("click", () => {
  Sound.setMuted(!Sound.isMuted());
  updateMuteIcon();
});

// ---- Sharing ----
function buildShareText(score) {
  return `I just scored ${score} dodging invading monsters in Hoodie Run and earned $${Wallet.tokenSymbol} for it. Can you beat me?`;
}

els.shareBtn.addEventListener("click", () => {
  const text = buildShareText(lastScore);
  const url = CONFIG.SHARE_URL;
  if (navigator.share) {
    navigator.share({ text, url }).catch(() => {});
  } else {
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`;
    window.open(intent, "_blank", "noopener");
  }
});

// ---- Claiming (always available — sharing is just suggested first) ----
els.claimBtn.addEventListener("click", async () => {
  if (!Wallet.getState().connected) {
    els.modalMsg.textContent = "Paste your address above first, then claim.";
    return;
  }
  els.claimBtn.disabled = true;
  els.modalMsg.textContent = "Validating run and queuing reward...";
  const result = await Wallet.submitRun(lastScore);

  if (result.status === "queued") {
    els.modalMsg.textContent = "Queued — HOODIE lands within seconds, batched with other players right now.";
    Wallet.pollRewardStatus(result.sessionId, (status) => {
      if (status.status === "sent") {
        els.modalMsg.textContent = `Sent! Tx: ${status.txHash.slice(0, 10)}...`;
        Sound.reward();
        refreshLeaderboard();
      }
    }).then((finalStatus) => {
      if (finalStatus.status === "timeout") {
        els.modalMsg.textContent = "Still processing — check your balance shortly.";
      } else if (finalStatus.status === "failed") {
        els.modalMsg.textContent = "The batch payout failed and will be retried automatically.";
      }
    });
  } else if (result.status === "below-threshold") {
    els.modalMsg.textContent = "Good run, but just under the reward threshold this time — try again!";
  } else if (result.status === "no-session") {
    els.modalMsg.textContent = "No valid run session — play a full run, then claim.";
  } else if (result.status === "rejected") {
    els.modalMsg.textContent = result.message || "This run was already claimed.";
  } else {
    els.modalMsg.textContent = result.message || "Couldn't process the reward this time.";
    els.claimBtn.disabled = false;
  }
});

// ---- Leaderboard ----
async function refreshLeaderboard() {
  try {
    const res = await fetch(`${CONFIG.BACKEND_URL}/api/leaderboard`);
    if (!res.ok) return;
    const { leaderboard } = await res.json();
    els.leaderboardList.innerHTML = "";
    if (!leaderboard.length) {
      els.leaderboardList.innerHTML = `<li class="empty">No runs yet — be the first.</li>`;
      return;
    }
    leaderboard.slice(0, 10).forEach((entry, i) => {
      const li = document.createElement("li");
      li.innerHTML = `<span class="rank">${i + 1}</span><span class="addr">${shortAddr(entry.player)}</span><span class="pts">${entry.score}</span>`;
      els.leaderboardList.appendChild(li);
    });
  } catch {
    els.leaderboardList.innerHTML = `<li class="empty">Leaderboard unavailable right now.</li>`;
  }
}

// ---- Mobile duck button (desktop/mouse only — hidden on touch via CSS) ----
["pointerdown", "touchstart"].forEach((evt) =>
  els.duckBtn.addEventListener(evt, (e) => {
    e.preventDefault();
    Game.setDuck(true);
  })
);
["pointerup", "pointerleave", "touchend"].forEach((evt) =>
  els.duckBtn.addEventListener(evt, (e) => {
    e.preventDefault();
    Game.setDuck(false);
  })
);

// ---- Game-over reward popup ----
function closeModalAndRestart() {
  els.modal.classList.add("hidden");
  Game.jump(); // game isn't "started" at this point, so this starts a fresh run
}
els.modalCloseBtn.addEventListener("click", closeModalAndRestart);

Game.init(document.getElementById("game-canvas"), {
  onStart: () => {
    els.modal.classList.add("hidden");
    els.balance.textContent = "0.00";
    trySaveAddress(); // in case a run starts right after typing, before blur/debounce fires
    Wallet.startRunSession();
  },
  onScoreUpdate: (score) => {
    lastScore = score;
    els.score.textContent = score;
    els.balanceSymbol.textContent = Wallet.tokenSymbol;
    els.balance.textContent = Number(Wallet.estimateReward(score)).toFixed(2);
  },
  onGameOver: (score) => {
    lastScore = score;
    if (score > bestScore) {
      bestScore = score;
      localStorage.setItem("hoodie_run_best_score", String(bestScore));
      els.best.textContent = bestScore;
    }
    if (score <= 0) return;

    els.modalScore.textContent = score;
    els.claimBtn.disabled = false;
    els.modalMsg.textContent = Wallet.getState().connected
      ? "Share it, then claim your reward below."
      : "Paste your address above (or after closing this) to claim rewards.";
    els.modal.classList.remove("hidden");
  },
});

refreshAddressUI();
refreshLeaderboard();