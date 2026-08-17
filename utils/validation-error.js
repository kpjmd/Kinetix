// /utils/validation-error.js
// Error type for caller-supplied bad input, as opposed to a server fault.
//
// Express error handlers in this repo branch on `err.status || 500`, so
// throwing this from a service layer surfaces as a 400 without the handler
// needing to know which service threw it.

class ValidationError extends Error {
  // `responseBody` lets a caller override the default `{error, details}` JSON
  // shape (e.g. a "missing required fields" list) while still using the same
  // throw-and-catch path as every other validation failure.
  constructor(message, responseBody) {
    super(message);
    this.name = 'ValidationError';
    this.status = 400;
    this.responseBody = responseBody;
  }
}

module.exports = { ValidationError };
