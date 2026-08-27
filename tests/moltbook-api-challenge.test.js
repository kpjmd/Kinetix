// Regression test for the Aug 2026 challenge-detection gap: Moltbook's
// response envelope changed to wrap resources under `post` (confirmed via
// GET /posts/{id}), and the challenge-detection interceptor only checked
// `data.verification`, missing `data.post.verification`. Two posts sat at
// verification_status: "pending" with zero challenge-solver log activity as
// a result. This locks in that both envelope shapes are detected.

jest.mock('axios');

const axios = require('axios');

describe('Moltbook API challenge detection (envelope-shape robustness)', () => {
  let responseInterceptor;

  beforeAll(() => {
    const mockClient = {
      interceptors: {
        request: { use: jest.fn() },
        response: { use: jest.fn(onFulfilled => { responseInterceptor = onFulfilled; }) }
      },
      post: jest.fn(),
      get: jest.fn(),
      delete: jest.fn()
    };
    axios.create.mockReturnValue(mockClient);
    jest.isolateModules(() => {
      require('../utils/moltbook-api');
    });
  });

  it('detects a challenge in the flat, July-2026-confirmed shape (data.verification)', () => {
    const response = {
      data: {
        id: 'post-1',
        title: 't',
        content: 'c',
        verification: { challenge_text: '2 + 2', verification_code: 'abc' }
      }
    };

    expect(() => responseInterceptor(response)).toThrow();
    try {
      responseInterceptor(response);
    } catch (err) {
      expect(err.isChallenge).toBe(true);
      expect(err.challengeData.id).toBe('post-1');
      expect(err.challengeData.verification.challenge_text).toBe('2 + 2');
    }
  });

  it('detects a challenge in the wrapped envelope shape (data.post.verification)', () => {
    const response = {
      data: {
        success: true,
        post: {
          id: 'post-2',
          title: 't',
          content: 'c',
          verification: { challenge_text: '3 + 3', verification_code: 'xyz' }
        }
      }
    };

    expect(() => responseInterceptor(response)).toThrow();
    try {
      responseInterceptor(response);
    } catch (err) {
      expect(err.isChallenge).toBe(true);
      // challengeData must be unwrapped to the flat post resource so callers
      // (createPost, challenge-solver's getVerificationBlock) see .id and
      // .verification directly, regardless of envelope.
      expect(err.challengeData.id).toBe('post-2');
      expect(err.challengeData.verification.challenge_text).toBe('3 + 3');
    }
  });

  it('passes through a normal response with no challenge, either shape', () => {
    const flat = { data: { id: 'post-3', title: 't', content: 'c' } };
    const wrapped = { data: { success: true, post: { id: 'post-4', title: 't', content: 'c' } } };

    expect(responseInterceptor(flat)).toBe(flat);
    expect(responseInterceptor(wrapped)).toBe(wrapped);
  });
});
