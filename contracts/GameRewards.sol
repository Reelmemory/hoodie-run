// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

/// @title GameRewards
/// @notice Pays out an existing ERC-20 memecoin ($HOODIE) to players based on
///         their Hoodie Run score. This contract holds a reward reserve (send
///         the project's tokens directly to this contract's address to fund
///         it) and pays out of that balance until it runs out.
///
/// @dev Trust model: the game runs in the player's browser, so a raw score
///      can't be trusted on its own. Instead of asking the player to submit
///      a signed score claim themselves, the trusted backend
///      (backend/server.js) validates each run server-side and then calls
///      `distributeReward` (or, more commonly, batches many runs into one
///      `distributeBatch` call every few minutes to save gas) — the reward
///      lands in the player's wallet with no signature, click, or gas cost
///      from the player.
///      `onlyDistributor` is the entire trust boundary: whoever holds that
///      key can trigger payouts, so treat it like a hot wallet (keep it
///      funded only with gas money, rotate it via `setDistributor` if it's
///      ever suspected compromised, and rely on the cooldown + per-claim
///      cap below to bound the damage of any single bad call).
contract GameRewards is Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable token;
    address public distributor;

    // Reward paid per point of score, in the token's own smallest unit.
    // 1 ether = 1 full token per point, assuming an 18-decimal token (check
    // HOODIE's actual decimals on Blockscout and adjust via setRewardParams
    // if it differs).
    uint256 public rewardPerPoint = 1 ether;

    // Hard cap per single distribution, regardless of score. Scaled up
    // proportionally with rewardPerPoint (100x) so the cap still kicks in at
    // roughly the same score level as before (~50,000 points) rather than
    // suddenly capping out at 500 points.
    uint256 public maxRewardPerClaim = 50000 ether;

    // Minimum time between payouts per address (also bounds gas spend).
    uint256 public claimCooldown = 60 seconds;

    // Upper bound on players per distributeBatch call, so one batch can't
    // grow large enough to risk hitting a block gas limit.
    uint256 public constant MAX_BATCH_SIZE = 150;

    mapping(address => uint256) public lastClaimAt;
    mapping(address => uint256) public totalEarned;
    mapping(address => uint256) public bestScore;

    event RewardDistributed(address indexed player, uint256 score, uint256 amount);
    event BatchDistributed(uint256 count, uint256 totalAmount);
    event DistributorUpdated(address indexed newDistributor);
    event RewardParamsUpdated(uint256 rewardPerPoint, uint256 maxRewardPerClaim);
    event CooldownUpdated(uint256 newCooldown);
    event ReserveWithdrawn(address indexed to, uint256 amount);

    error NotDistributor();
    error ZeroScore();
    error CooldownActive(uint256 availableAt);
    error InsufficientReserve();
    error LengthMismatch();
    error BatchTooLarge();

    modifier onlyDistributor() {
        if (msg.sender != distributor) revert NotDistributor();
        _;
    }

    constructor(address admin, IERC20 _token, address _distributor) Ownable(admin) {
        token = _token;
        distributor = _distributor;
    }

    /// @notice Called by the backend after it validates a run. Sends reward
    ///         tokens straight to `player` from this contract's balance.
    function distributeReward(address player, uint256 score) external onlyDistributor returns (uint256 amount) {
        if (score == 0) revert ZeroScore();
        if (block.timestamp < lastClaimAt[player] + claimCooldown) {
            revert CooldownActive(lastClaimAt[player] + claimCooldown);
        }

        amount = score * rewardPerPoint;
        if (amount > maxRewardPerClaim) amount = maxRewardPerClaim;

        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) revert InsufficientReserve();
        if (amount > balance) amount = balance; // pay out what's left rather than reverting

        lastClaimAt[player] = block.timestamp;
        totalEarned[player] += amount;
        if (score > bestScore[player]) bestScore[player] = score;

        token.safeTransfer(player, amount);
        emit RewardDistributed(player, score, amount);
    }

    /// @notice Batched version of distributeReward — pays out many players in
    ///         a single transaction (one base tx cost instead of N). Used by
    ///         the backend's periodic batch job instead of calling
    ///         distributeReward once per run.
    ///
    ///         Unlike distributeReward, a per-player issue (zero score,
    ///         cooldown still active, empty reserve) simply skips that player
    ///         (amount 0 in the returned array) rather than reverting the
    ///         whole batch — one bad entry shouldn't block everyone else's
    ///         payout in the same batch.
    function distributeBatch(address[] calldata players, uint256[] calldata scores)
        external
        onlyDistributor
        returns (uint256[] memory amounts)
    {
        if (players.length != scores.length) revert LengthMismatch();
        if (players.length > MAX_BATCH_SIZE) revert BatchTooLarge();

        amounts = new uint256[](players.length);
        uint256 totalAmount;

        for (uint256 i = 0; i < players.length; i++) {
            address player = players[i];
            uint256 score = scores[i];

            if (score == 0) continue;
            if (block.timestamp < lastClaimAt[player] + claimCooldown) continue;

            uint256 amount = score * rewardPerPoint;
            if (amount > maxRewardPerClaim) amount = maxRewardPerClaim;

            uint256 balance = token.balanceOf(address(this));
            if (balance == 0) break; // reserve empty — stop, nothing left for the rest either
            if (amount > balance) amount = balance;

            lastClaimAt[player] = block.timestamp;
            totalEarned[player] += amount;
            if (score > bestScore[player]) bestScore[player] = score;

            token.safeTransfer(player, amount);
            amounts[i] = amount;
            totalAmount += amount;
            emit RewardDistributed(player, score, amount);
        }

        emit BatchDistributed(players.length, totalAmount);
    }

    /// @notice Current reserve available for payouts.
    function reserveBalance() external view returns (uint256) {
        return token.balanceOf(address(this));
    }

    function setDistributor(address newDistributor) external onlyOwner {
        distributor = newDistributor;
        emit DistributorUpdated(newDistributor);
    }

    function setRewardParams(uint256 newRewardPerPoint, uint256 newMaxRewardPerClaim) external onlyOwner {
        rewardPerPoint = newRewardPerPoint;
        maxRewardPerClaim = newMaxRewardPerClaim;
        emit RewardParamsUpdated(newRewardPerPoint, newMaxRewardPerClaim);
    }

    function setCooldown(uint256 newCooldown) external onlyOwner {
        claimCooldown = newCooldown;
        emit CooldownUpdated(newCooldown);
    }

    /// @notice Owner can pull unused reserve back out (e.g. to top up
    ///         elsewhere, or before migrating to a new contract version).
    function withdrawReserve(address to, uint256 amount) external onlyOwner {
        token.safeTransfer(to, amount);
        emit ReserveWithdrawn(to, amount);
    }
}
