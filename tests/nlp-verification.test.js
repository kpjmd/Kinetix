// tests/nlp-verification.test.js
// The Telegram verification_create tool used to create commitments with no
// platform identity at all, which monitoring could never collect for.

jest.mock('../services/data-store');

const { executeVerificationTool } = require('../utils/nlp-verification');

const NPUB = 'npub1xpxr0awey3j9q3p9ss3lfsm5hue2wdzgkkthz04js6vl0qe6af2s39ufc5';
const HEX = '304c37f5d924645044258423f4c374bf32a73448b597713eb28699f7833aea55';

describe('verification_create tool', () => {
  let createVerification;
  const run = input => executeVerificationTool('verification_create', {
    description: 'post daily',
    verification_type: 'consistency',
    ...input
  }, { verificationService: { createVerification } });

  beforeEach(() => {
    createVerification = jest.fn().mockResolvedValue({ verification_id: 'v1', status: 'monitoring' });
  });

  it('rejects a platform with no evidence collector', async () => {
    const result = await run({ agent_id: 'someone', platform: 'telegram' });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unsupported platform/);
    expect(createVerification).not.toHaveBeenCalled();
  });

  it('stores a clawstr agent as a hex pubkey the collector can query', async () => {
    const result = await run({ agent_id: NPUB, platform: 'clawstr' });

    expect(result.success).toBe(true);
    expect(createVerification).toHaveBeenCalledWith(expect.objectContaining({
      pubkey: HEX,
      platform_profiles: { clawstr: NPUB },
      criteria: { platform: 'clawstr' }
    }));
  });

  it('rejects a clawstr agent_id that is not a Nostr key', async () => {
    const result = await run({ agent_id: 'some_username', platform: 'clawstr' });

    expect(result.success).toBe(false);
    expect(createVerification).not.toHaveBeenCalled();
  });

  it('sets the moltbook profile, and the validated platform wins over criteria', async () => {
    await run({ agent_id: 'someagent', platform: 'moltbook', criteria: { platform: 'base_l2', duration_days: 3 } });

    expect(createVerification).toHaveBeenCalledWith(expect.objectContaining({
      platform_profiles: { moltbook: 'someagent' },
      criteria: { platform: 'moltbook', duration_days: 3 }
    }));
  });
});
