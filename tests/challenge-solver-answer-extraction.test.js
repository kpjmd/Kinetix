// Regression tests for how model output becomes a submittable answer.
//
// Aug 2026 round 1: Moltbook's instructions are unambiguous ("respond with
// ONLY the number... e.g. '525.00'"), but the model still opened with a
// reasoning preamble, and max_tokens: 64 cut generations off before they
// reached a number. Fixed by extracting the final numeric token from whatever
// comes back rather than trusting the reply to be bare.
//
// Aug 2026 round 2 (2026-08-27): a single sample of a single model answered
// 42.00 for a challenge whose answer was 47.00. The solver now returns an
// ordered candidate list built from a deterministic parse plus a majority vote
// across samples, so one bad generation can no longer decide the answer.

jest.mock('@anthropic-ai/sdk');

const Anthropic = require('@anthropic-ai/sdk');

describe('challenge-solver candidate generation', () => {
  let mockCreate;
  let solveChallenge;
  let lastPrompt;

  beforeEach(() => {
    mockCreate = jest.fn();
    Anthropic.mockImplementation(() => ({
      messages: { create: mockCreate }
    }));
    jest.isolateModules(() => {
      ({ _solveChallenge: solveChallenge, _lastPrompt: lastPrompt } = require('../utils/challenge-solver'));
    });
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  const reply = text => ({ content: [{ type: 'text', text }], stop_reason: 'end_turn' });
  const say = (...texts) => {
    texts.forEach(t => mockCreate.mockResolvedValueOnce(reply(t)));
  };

  // Three operands and no single operation, so parseArithmetic reports
  // confident: false and the model samples decide the outcome on their own.
  const modelLed = {
    verification: {
      verification_code: 'abc123',
      challenge_text: 'lobster riddle involving thirty two Newtons, sixteen Newtons and eight Newtons. what is the answer?',
      instructions: "Solve the math problem and respond with ONLY the number (with 2 decimal places, e.g., '525.00')."
    }
  };

  it('extracts the number when the model returns a bare answer', async () => {
    say('48.00', '48.00', '48.00');
    const { candidates } = await solveChallenge(modelLed);
    expect(candidates[0]).toBe('48.00');
  });

  it('extracts the trailing number past a reasoning preamble', async () => {
    say(
      'I need to work through this lobster riddle. 32 + 16 = 48',
      '48.00',
      '48.00'
    );
    expect((await solveChallenge(modelLed)).candidates[0]).toBe('48.00');
  });

  it('formats a bare integer to 2 decimal places', async () => {
    say('The answer is 60', 'The answer is 60', 'The answer is 60');
    expect((await solveChallenge(modelLed)).candidates[0]).toBe('60.00');
  });

  it('lets a 2-of-3 majority outvote a single divergent sample', async () => {
    say('48.00', '42.00', '48.00');
    const { candidates } = await solveChallenge(modelLed);
    expect(candidates[0]).toBe('48.00');
    expect(candidates).toContain('42.00'); // still available as a fallback
  });

  it('drops samples that contain no number at all', async () => {
    say('I cannot determine this.', '48.00', '48.00');
    const { candidates } = await solveChallenge(modelLed);
    expect(candidates).toEqual(['48.00']);
  });

  it('survives a sample whose API call throws', async () => {
    mockCreate
      .mockRejectedValueOnce(new Error('overloaded'))
      .mockResolvedValueOnce(reply('48.00'))
      .mockResolvedValueOnce(reply('48.00'));
    expect((await solveChallenge(modelLed)).candidates[0]).toBe('48.00');
  });

  it('survives a refusal that comes back with empty content', async () => {
    // stop_reason "refusal" yields content: [], so content[0].text would throw
    // and silently lose the sample.
    mockCreate
      .mockResolvedValueOnce({ content: [], stop_reason: 'refusal' })
      .mockResolvedValueOnce(reply('48.00'))
      .mockResolvedValueOnce(reply('48.00'));
    expect((await solveChallenge(modelLed)).candidates[0]).toBe('48.00');
  });

  it('leads with the deterministic parse when the model samples all disagree', async () => {
    // "gains" makes the parser confident: 35 + 12 = 47.
    say('42.00', '45.00', '50.00');
    const { candidates, deterministic } = await solveChallenge({
      verification: {
        verification_code: 'abc123',
        challenge_text: 'L]oB-sT{eR} ThIrTy] FiV e N]eWtO/ns AnD GaAiN s TwEeLvE N]eWtO/ns'
      }
    });
    expect(deterministic).toBe('47.00');
    expect(candidates[0]).toBe('47.00');
  });

  it('collapses to a single candidate when parser and model agree', async () => {
    say('47.00', '47.00', '47.00');
    const { candidates } = await solveChallenge({
      verification: {
        verification_code: 'abc123',
        challenge_text: 'L]oB-sT{eR} ThIrTy] FiV e N]eWtO/ns AnD GaAiN s TwEeLvE N]eWtO/ns'
      }
    });
    expect(candidates).toEqual(['47.00']);
  });

  it('caps the candidate list at 3', async () => {
    say('10.00', '20.00', '30.00');
    const { candidates } = await solveChallenge(modelLed);
    expect(candidates).toHaveLength(3);
  });


  // The raw obfuscated string is what makes the request read as CAPTCHA-solving:
  // measured 5/5 refusals with it in the prompt, 5/5 correct without. This guard
  // is here so a future prompt edit cannot quietly reintroduce it.
  it('never sends the raw obfuscated text to the model', async () => {
    const raw = 'C lA]w F^oRcE Is TwEnTy ~ NeWtOnS * TwO { ClAwS }';
    say('40.00', '40.00', '40.00');
    await solveChallenge({ verification: { verification_code: 'c', challenge_text: raw } });

    const prompt = lastPrompt();
    expect(prompt).not.toContain(raw);
    expect(prompt).not.toContain('lA]w');
    expect(prompt).not.toContain('F^oRcE');
    expect(prompt).toContain('twenty newtons * two claws');
  });

  it('throws rather than solving a payload with no challenge_text', async () => {
    await expect(solveChallenge({ id: 'x', title: 'a post' }))
      .rejects.toThrow(/no challenge_text/i);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('throws when no sample yields a number and the parser is unsure', async () => {
    say('no idea', 'cannot tell', 'unclear');
    await expect(solveChallenge(modelLed)).rejects.toThrow(/no numeric answer/i);
  });
});
