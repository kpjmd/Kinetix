// tests/gas-guard.test.js
// Tests for the shared gas-price ceiling used by both on-chain submitters
// (utils/erc8004-reputation.js and utils/eas-attestation.js). No network —
// provider is a hand-built fake.

const { assertGasWithinCeiling } = require('../utils/gas-guard');

function fakeProvider(feeData) {
  return { getFeeData: async () => feeData };
}

describe('assertGasWithinCeiling', () => {
  const ORIGINAL = process.env.MAX_SUBMISSION_FEE_GWEI;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MAX_SUBMISSION_FEE_GWEI;
    else process.env.MAX_SUBMISSION_FEE_GWEI = ORIGINAL;
  });

  it('does not throw when gas price is under the default 50 gwei ceiling', async () => {
    delete process.env.MAX_SUBMISSION_FEE_GWEI;
    const provider = fakeProvider({ maxFeePerGas: 1_000_000_000n }); // 1 gwei
    await expect(assertGasWithinCeiling(provider)).resolves.toBeUndefined();
  });

  it('throws GAS_CEILING when gas price exceeds the default ceiling', async () => {
    delete process.env.MAX_SUBMISSION_FEE_GWEI;
    const provider = fakeProvider({ maxFeePerGas: 1_000_000_000_000n }); // 1000 gwei
    await expect(assertGasWithinCeiling(provider)).rejects.toMatchObject({ code: 'GAS_CEILING' });
  });

  it('honours a MAX_SUBMISSION_FEE_GWEI override', async () => {
    process.env.MAX_SUBMISSION_FEE_GWEI = '2';
    const provider = fakeProvider({ maxFeePerGas: 3_000_000_000n }); // 3 gwei > 2 gwei ceiling
    await expect(assertGasWithinCeiling(provider)).rejects.toMatchObject({ code: 'GAS_CEILING' });
  });

  it('prefers maxFeePerGas over gasPrice when both are present', async () => {
    delete process.env.MAX_SUBMISSION_FEE_GWEI;
    // gasPrice alone would be over ceiling; maxFeePerGas (preferred) is under it.
    const provider = fakeProvider({ maxFeePerGas: 1_000_000_000n, gasPrice: 1_000_000_000_000n });
    await expect(assertGasWithinCeiling(provider)).resolves.toBeUndefined();
  });

  it('falls back to gasPrice when maxFeePerGas is absent', async () => {
    delete process.env.MAX_SUBMISSION_FEE_GWEI;
    const provider = fakeProvider({ gasPrice: 1_000_000_000_000n }); // 1000 gwei
    await expect(assertGasWithinCeiling(provider)).rejects.toMatchObject({ code: 'GAS_CEILING' });
  });

  it('does not throw when fee data is entirely unavailable (never blocks on missing data)', async () => {
    const provider = fakeProvider({});
    await expect(assertGasWithinCeiling(provider)).resolves.toBeUndefined();
  });
});
