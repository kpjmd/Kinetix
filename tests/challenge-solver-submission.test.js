// The 2026-08-27 logs showed the submitter conflating two distinct 400s:
//   wrong answer  -> { message: "Incorrect answer", success: false }
//   wrong payload -> { message: ["verification_code must be a string"] }
// It treated the first as a payload problem, retried with a strictly worse
// shape, and gave up — never using Moltbook's own "incorrect" reply to try a
// different number. These tests pin the corrected behavior.

jest.mock('axios');

const axios = require('axios');
const {
  _submitChallengeAnswer: submitChallengeAnswer,
  _classifyVerifyResponse: classify,
  _parseExpiry: parseExpiry
} = require('../utils/challenge-solver');

const reject = (status, data) => {
  const err = new Error(`Request failed with status code ${status}`);
  err.response = { status, data };
  return Promise.reject(err);
};

const INCORRECT = () => reject(400, {
  statusCode: 400,
  message: 'Incorrect answer',
  success: false,
  hint: 'Your answer was incorrect. Double-check your math'
});
const BAD_SHAPE = () => reject(400, {
  statusCode: 400,
  message: ['verification_code must be a string'],
  error: 'Bad Request'
});
const OK = () => Promise.resolve({ status: 200, data: { success: true, verified: true } });

const challengeData = {
  id: 'e7c0338a-5fc8-41bd-b3c1-66459f0ad991',
  verification: {
    verification_code: 'moltbook_verify_bd83b4f6f29152c0a45eaaf19301233b',
    challenge_text: 'thirty five newtons and gains twelve newtons',
    expires_at: '2036-08-27 16:07:16.099559+00'
  }
};

describe('classifyVerifyResponse', () => {
  it('reads "Incorrect answer" as a wrong answer, not a bad payload', () => {
    expect(classify(400, { message: 'Incorrect answer', success: false })).toBe('incorrect');
  });

  it('reads a validation array as a payload-shape problem', () => {
    expect(classify(400, { message: ['verification_code must be a string'] })).toBe('shape');
  });

  it('does not count a 2xx carrying success:false as verified', () => {
    expect(classify(200, { success: false, message: 'nope' })).toBe('incorrect');
  });

  it('treats a plain 2xx as verified', () => {
    expect(classify(200, { success: true })).toBe('verified');
  });

  it('detects an expired challenge', () => {
    expect(classify(400, { message: 'Verification code expired' })).toBe('expired');
  });

  it('treats an already-verified reply as success', () => {
    expect(classify(400, { message: 'Content already verified' })).toBe('verified');
  });
});

describe('parseExpiry', () => {
  it('parses Moltbook\'s space-separated microsecond timestamp', () => {
    expect(parseExpiry('2026-08-27 16:07:16.099559+00'))
      .toBe(Date.parse('2026-08-27T16:07:16.099Z'));
  });

  it('returns null for missing or unparseable values', () => {
    expect(parseExpiry(null)).toBeNull();
    expect(parseExpiry('not a date')).toBeNull();
  });
});

describe('submitChallengeAnswer', () => {
  beforeEach(() => {
    axios.post.mockReset();
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => jest.restoreAllMocks());

  it('advances to the next candidate when the answer is incorrect', async () => {
    axios.post.mockImplementationOnce(INCORRECT).mockImplementationOnce(OK);
    await expect(submitChallengeAnswer(challengeData, ['42.00', '47.00']))
      .resolves.toMatchObject({ verified: true });
    expect(axios.post).toHaveBeenCalledTimes(2);
    expect(axios.post.mock.calls[0][1].answer).toBe('42.00');
    expect(axios.post.mock.calls[1][1].answer).toBe('47.00');
  });

  it('always sends verification_code alongside the answer', async () => {
    axios.post.mockImplementation(OK);
    await submitChallengeAnswer(challengeData, ['47.00']);
    expect(axios.post.mock.calls[0][1]).toEqual({
      verification_code: challengeData.verification.verification_code,
      answer: '47.00'
    });
  });

  it('retries the same answer with a different shape on a validation error', async () => {
    axios.post.mockImplementationOnce(BAD_SHAPE).mockImplementationOnce(OK);
    await submitChallengeAnswer(challengeData, ['47.00', '48.00']);
    expect(axios.post).toHaveBeenCalledTimes(2);
    // Same answer, coerced to a number - not a jump to the next candidate.
    expect(axios.post.mock.calls[1][1].answer).toBe(47);
  });

  it('never submits the same answer twice', async () => {
    axios.post.mockImplementation(INCORRECT);
    await expect(submitChallengeAnswer(challengeData, ['47.00', '47.00', '48.00']))
      .rejects.toThrow(/verification failed/i);
    const answers = axios.post.mock.calls.map(c => c[1].answer);
    expect(answers).toEqual(['47.00', '48.00']);
  });

  it('stops immediately when the challenge has expired server-side', async () => {
    axios.post.mockImplementationOnce(() => reject(400, { message: 'Verification code expired' }));
    await expect(submitChallengeAnswer(challengeData, ['47.00', '48.00']))
      .rejects.toThrow(/verification failed/i);
    expect(axios.post).toHaveBeenCalledTimes(1);
  });

  it('does not submit at all once expires_at has passed', async () => {
    const expired = {
      ...challengeData,
      verification: { ...challengeData.verification, expires_at: '2020-01-01 00:00:00.000000+00' }
    };
    await expect(submitChallengeAnswer(expired, ['47.00'])).rejects.toThrow(/verification failed/i);
    expect(axios.post).not.toHaveBeenCalled();
  });

  it('throws a typed error carrying the content id and answers tried', async () => {
    axios.post.mockImplementation(INCORRECT);
    await expect(submitChallengeAnswer(challengeData, ['42.00', '47.00'])).rejects.toMatchObject({
      verificationFailed: true,
      contentId: challengeData.id,
      candidatesTried: ['42.00', '47.00']
    });
  });

  it('falls back to a bare { answer } payload only when there is no code', async () => {
    axios.post.mockImplementation(OK);
    await submitChallengeAnswer({ id: 'x', verification: { challenge_text: 'q' } }, ['47.00']);
    expect(axios.post.mock.calls[0][1]).toEqual({ answer: '47.00' });
  });
});
