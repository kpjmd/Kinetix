// /api/index.js
// Express API server for verification services

const express = require('express');
const verificationRoutes = require('./routes/verification');
const { createRateLimiter } = require('../utils/rate-limiter');

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

module.exports = { createApiServer };
