// /api/index.js
// Express API server for verification services

const express = require('express');
const verificationRoutes = require('./routes/verification');

/**
 * Create and configure the Express API server
 * @param {Object} services - { verificationService, attestationService, monitoringService }
 * @returns {express.Application}
 */
function createApiServer(services) {
  const app = express();

  app.use(express.json());

  // Simple rate limiter (in-memory, per IP)
  const rateLimiter = createRateLimiter(100, 60 * 60 * 1000); // 100 req/hour
  app.use('/api/', rateLimiter);

  // Mount verification routes
  app.use('/api/v1', verificationRoutes(services));

  // Health check
  app.get('/health', (req, res) => {
    res.json({
      status: 'ok',
      service: 'kinetix-api',
      timestamp: new Date().toISOString()
    });
  });

  // Error handler
  app.use((err, req, res, next) => {
    console.error(`[API Error] ${err.message}`);
    res.status(err.status || 500).json({
      error: err.message || 'Internal server error'
    });
  });

  return app;
}

/**
 * Simple in-memory rate limiter
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

module.exports = { createApiServer };
