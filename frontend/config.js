// ---- Fill these in (see ../README.md) ----
const CONFIG = {
  // Backend service (backend/server.js)
  BACKEND_URL: "https://hoodie-run.onrender.com",

  // The existing memecoin's contract address (from Etherscan)
  MEMECOIN_ADDRESS: "0xC72c01AAB5f5678dc1d6f5C6d2B417d91D402Ba3",

  // Ticker shown in the UI and share text. Update to match the real token —
  // it's also fetched live from the contract where possible as a fallback.
  MEMECOIN_SYMBOL: "HOODIE",

  // Deployed GameRewards contract address
  GAME_REWARDS_ADDRESS: "0xD39aEA420bD894c73755c9db23c9C8A377A8370C",

  // HOODIE lives on Robinhood Chain (Robinhood's Arbitrum-Orbit L2), not
  // Ethereum mainnet — the game needs to be on the same chain as the token.
  NETWORK: {
    chainIdHex: "0x1237", // 4663
    chainId: 4663,
    chainName: "Robinhood Chain",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    blockExplorerUrls: ["https://robinhoodchain.blockscout.com"],
  },

  // Shown on the share button / tweet intent
  SHARE_URL: "https://hoodie-run-1.onrender.com",
};
