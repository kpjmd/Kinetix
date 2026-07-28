// tests/data-store.test.js
// Covers ERC-8004 identity resolution, which decides whether this process
// believes Kinetix is registered at all. No network, no RPC — the check is
// purely "does a file exist and parse".

const fs = require('fs');
const os = require('os');
const path = require('path');

// data-store reads DATA_DIR once at module load, so it must be set first and
// the module required fresh per case.
function loadDataStoreWith(dataDir) {
  jest.resetModules();
  process.env.DATA_DIR = dataDir;
  return require('../services/data-store');
}

describe('loadERC8004Identity', () => {
  let tmpDir;
  const originalDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kinetix-ds-'));
    fs.mkdirSync(path.join(tmpDir, 'erc8004'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
  });

  it('falls back to the packaged record when the volume has none', async () => {
    // The exact production condition: DATA_DIR is a mounted Railway volume that
    // never ran the registration script, while the git-tracked record sits in
    // the deploy image. Without the fallback this raised "Kinetix not
    // registered on base_mainnet" on a network where it demonstrably is, and
    // every ERC-8004 submission from that service failed at init.
    const dataStore = loadDataStoreWith(tmpDir);

    const identity = await dataStore.loadERC8004Identity('base_mainnet');

    expect(identity).not.toBeNull();
    expect(identity.tokenId).toBe('16892');
    // The full record, not just an id — this is why the env var alone is not
    // a sufficient substitute.
    expect(identity.controller).toMatch(/^0x[a-fA-F0-9]{40}$/);
    expect(identity.metadataURI).toBeTruthy();
  });

  it('prefers the volume record, so a re-registration stays authoritative', async () => {
    fs.writeFileSync(
      path.join(tmpDir, 'erc8004', 'identity-base_mainnet.json'),
      JSON.stringify({ network: 'base_mainnet', tokenId: '99999', controller: '0x' + '1'.repeat(40) })
    );
    const dataStore = loadDataStoreWith(tmpDir);

    const identity = await dataStore.loadERC8004Identity('base_mainnet');

    expect(identity.tokenId).toBe('99999');
  });

  it('still returns null for a network that was never registered', async () => {
    // The fallback must not make every network look registered — a genuinely
    // unregistered network has to keep failing loudly.
    const dataStore = loadDataStoreWith(tmpDir);

    await expect(dataStore.loadERC8004Identity('base_nonesuch')).resolves.toBeNull();
  });
});
