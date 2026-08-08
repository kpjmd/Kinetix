// /utils/gas-guard.js
// Shared pre-flight gas-price ceiling, extracted from erc8004-reputation.js so
// the EAS submission path (which had no such guard) can use the same check.
// Both submitters run on the raw signing wallet, which bypasses
// SafetyController — this is what bounds per-tx fee for either of them.

const { ethers } = require('ethers');

/**
 * Throw GAS_CEILING if current gas price exceeds the configured ceiling.
 * Ceiling is MAX_SUBMISSION_FEE_GWEI (default 50 gwei — far above Base's
 * normal sub-gwei fees, so it only trips on abnormal spikes).
 * @param {ethers.Provider} provider
 */
async function assertGasWithinCeiling(provider) {
  const feeData = await provider.getFeeData();
  const gasPrice = feeData.maxFeePerGas || feeData.gasPrice;
  if (!gasPrice) return; // fee data unavailable — do not block
  const ceilingGwei = process.env.MAX_SUBMISSION_FEE_GWEI || '50';
  const ceilingWei = ethers.parseUnits(String(ceilingGwei), 'gwei');
  if (gasPrice > ceilingWei) {
    const err = new Error(
      `GAS_CEILING: gas price ${ethers.formatUnits(gasPrice, 'gwei')} gwei exceeds ceiling ${ceilingGwei} gwei — deferring submission.`
    );
    err.code = 'GAS_CEILING';
    throw err;
  }
}

module.exports = { assertGasWithinCeiling };
