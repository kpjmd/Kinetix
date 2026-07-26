// /utils/rate-limiter.js
// Simple in-memory per-IP rate limiter, shared by the free API and the
// x402 server. In-memory means the window is per-process and resets on
// redeploy — adequate for abuse control on free endpoints, not a quota.

/**
 * @param {number} maxRequests - requests allowed per window
 * @param {number} windowMs - window length in milliseconds
 * @returns {import('express').RequestHandler}
 */
function createRateLimiter(maxRequests, windowMs) {
  const requests = new Map(); // IP -> { count, resetTime }

  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const entry = requests.get(ip);

    if (!entry || now > entry.resetTime) {
      requests.set(ip, { count: 1, resetTime: now + windowMs });
      return next();
    }

    if (entry.count >= maxRequests) {
      return res.status(429).json({
        error: 'Rate limit exceeded',
        retry_after: Math.ceil((entry.resetTime - now) / 1000)
      });
    }

    entry.count++;
    next();
  };
}

module.exports = { createRateLimiter };
