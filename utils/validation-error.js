// /utils/validation-error.js
// Error type for caller-supplied bad input, as opposed to a server fault.
//
// Express error handlers in this repo branch on `err.status || 500`, so
// throwing this from a service layer surfaces as a 400 without the handler
// needing to know which service threw it.

// Guidance keys a thrower may attach. The paid x402 routes turn these into the
// error body, because a buyer agent can only repair a request it is told how
// to repair: OKX AI delisted this service after buyers retried bare messages
// like `Invalid checksum ... expected "t3jgw3"` and got nowhere.
const GUIDANCE_KEYS = ['code', 'field', 'received', 'expected', 'example', 'hint', 'required', 'missing'];

class ValidationError extends Error {
  // The second argument is either
  //   - guidance: any of GUIDANCE_KEYS, which the caller merges into its own
  //     response shape, or
  //   - a legacy `responseBody`: a full JSON body to send as-is (recognised by
  //     its `error` key).
  constructor(message, info) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.guidance = {};

    if (info && typeof info === 'object') {
      if ('error' in info) {
        this.responseBody = info;
      }
      for (const key of GUIDANCE_KEYS) {
        if (info[key] !== undefined) this.guidance[key] = info[key];
      }
    }
  }
}

module.exports = { ValidationError, GUIDANCE_KEYS };
