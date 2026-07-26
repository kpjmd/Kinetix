// /utils/validation-error.js
// Error type for caller-supplied bad input, as opposed to a server fault.
//
// Express error handlers in this repo branch on `err.status || 500`, so
// throwing this from a service layer surfaces as a 400 without the handler
// needing to know which service threw it.

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
  }
}

module.exports = { ValidationError };
