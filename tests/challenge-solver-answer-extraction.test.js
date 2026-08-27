// Regression test for the Aug 2026 answer-format bug: Moltbook's own
// instructions are unambiguous ("respond with ONLY the number... e.g.
// '525.00'"), but live logs showed Claude Haiku returning reasoning
// preambles ("I need to decode this lobster-themed math problem.",
// "The problem is asking: 32 N") that got cut off by the old max_tokens: 64
// before ever reaching a number — every submission failed Moltbook's
// "Invalid answer format" check as a result. This locks in that the final
// numeric token is extracted regardless of any surrounding text.

jest.mock('@anthropic-ai/sdk');

const Anthropic = require('@anthropic-ai/sdk');

describe('challenge-solver answer extraction', () => {
  let mockCreate;
  let solveChallenge;

  beforeEach(() => {
    mockCreate = jest.fn();
    Anthropic.mockImplementation(() => ({
      messages: { create: mockCreate }
    }));
    jest.isolateModules(() => {
      ({ _solveChallenge: solveChallenge } = require('../utils/challenge-solver'));
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const challengeData = {
    verification: {
      verification_code: 'abc123',
      challenge_text: 'lobster claw force is thirty two Newtons + sixteen Newtons how many total?',
      instructions: "Solve the math problem and respond with ONLY the number (with 2 decimal places, e.g., '525.00')."
    }
  };

  it('extracts the number when Haiku complies and returns a bare answer', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: '48.00' }] });
    await expect(solveChallenge(challengeData)).resolves.toBe('48.00');
  });

  it('extracts the trailing number when Haiku opens with a reasoning preamble', async () => {
    mockCreate.mockResolvedValue({
      content: [{ text: 'I need to decode this lobster-themed math problem. 32 + 16 = 48' }]
    });
    await expect(solveChallenge(challengeData)).resolves.toBe('48.00');
  });

  it('formats a bare integer to 2 decimal places', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: 'The answer is 60' }] });
    await expect(solveChallenge(challengeData)).resolves.toBe('60.00');
  });

  it('falls back to the raw trimmed text if no number is found at all', async () => {
    mockCreate.mockResolvedValue({ content: [{ text: 'I cannot determine this.' }] });
    await expect(solveChallenge(challengeData)).resolves.toBe('I cannot determine this.');
  });
});
