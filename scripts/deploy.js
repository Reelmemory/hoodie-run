const hre = require("hardhat");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const MEMECOIN_ADDRESS = process.env.MEMECOIN_ADDRESS;
  if (!MEMECOIN_ADDRESS) {
    throw new Error("Set MEMECOIN_ADDRESS in .env to the existing token's contract address");
  }

  // The wallet the backend uses to call distributeReward(). Fund it with a
  // small amount of ETH for gas — it never needs to hold the memecoin itself.
  const distributor = process.env.DISTRIBUTOR_ADDRESS || deployer.address;

  const GameRewards = await hre.ethers.getContractFactory("GameRewards");
  const rewards = await GameRewards.deploy(deployer.address, MEMECOIN_ADDRESS, distributor);
  await rewards.waitForDeployment();
  const rewardsAddress = await rewards.getAddress();
  console.log("GameRewards deployed to:", rewardsAddress);

  console.log("\nNext steps:");
  console.log(`  1. Send HOODIE to ${rewardsAddress} (on Robinhood Chain) to fund the reward reserve.`);
  console.log("  2. Call setRewardParams(rewardPerPoint, maxRewardPerClaim) once you know the token's decimals —");
  console.log("     defaults assume 18 decimals (0.01 token per point, 500 token max per claim).");
  console.log(`  3. Fund the distributor wallet (${distributor}) with a small amount of Robinhood Chain ETH for gas.`);
  console.log("  4. Put this address into frontend/config.js and backend/.env as REWARDS_CONTRACT_ADDRESS.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
