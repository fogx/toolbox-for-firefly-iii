import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { config, validateConfig } from './config/index.js';
import { loggers } from './utils/logger.js';
import { warmupPiiScrubber } from './utils/piiScrubber.js';
import {
  errorHandler,
  createSessionMiddleware,
  csrfProtection,
  csrfTokenCookie,
  configureSecurityMiddleware,
} from './middleware/index.js';
import {
  preloadFinTSBankIndex,
  startCleanupInterval,
  stopCleanupInterval,
} from './services/index.js';
import routes from './routes/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fail-fast: validate critical configuration before starting
const configValidation = validateConfig();

// Log warnings (non-fatal but important)
if (configValidation.warnings.length > 0) {
  loggers.server.warn('Configuration warnings:');
  for (const warning of configValidation.warnings) {
    loggers.server.warn(`  ${warning}`);
  }
}

// Handle errors (fatal in production)
if (!configValidation.valid) {
  loggers.server.error('Configuration errors detected:');
  for (const error of configValidation.errors) {
    loggers.server.error(`  ${error}`);
  }
  if (config.nodeEnv === 'production') {
    loggers.server.error('Server startup aborted due to configuration errors in production mode.');
    process.exit(1);
  } else {
    loggers.server.warn('Continuing in development mode despite configuration errors.');
  }
}

// Optional URL prefix for subpath deployments (e.g. "/toolbox" when mounted
// inside another app behind Caddy). Empty string = root, matching the legacy
// standalone-subdomain layout. Trailing slashes are stripped so the value can
// be concatenated as `${URL_BASE_PATH}/api` without double slashes.
const URL_BASE_PATH = (process.env.URL_BASE_PATH || '').replace(/\/+$/, '');

const app = express();

// Security middleware (Helmet, trust proxy, x-powered-by)
// Must be configured before other middleware
configureSecurityMiddleware(app);

// CORS configuration
app.use(
  cors({
    origin: config.corsOrigins,
    credentials: true,
  })
);

// Session middleware (must be before routes)
app.use(createSessionMiddleware());

// CSRF protection middleware
// - csrfTokenCookie: sets CSRF token cookie on all responses
// - csrfProtection: validates CSRF token on state-changing requests
app.use(csrfTokenCookie);
app.use(csrfProtection);

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// API routes (mounted under URL_BASE_PATH when configured)
app.use(`${URL_BASE_PATH}/api`, routes);

// Serve static files in production
if (config.nodeEnv === 'production') {
  const clientPath = path.resolve(__dirname, '../client');
  if (URL_BASE_PATH) {
    app.use(URL_BASE_PATH, express.static(clientPath));
  } else {
    app.use(express.static(clientPath));
  }

  // SPA fallback - Express 5 requires named wildcard parameter.
  // When mounted under a prefix, only catch requests at or below that prefix
  // so we don't shadow neighbouring routes upstream.
  app.get(`${URL_BASE_PATH}/*splat`, (_req, res) => {
    res.sendFile(path.join(clientPath, 'index.html'));
  });
}

// Global error handling middleware
app.use(errorHandler);

// Start server
const server = app.listen(config.port, () => {
  loggers.server.info(`Toolbox for Firefly III server running on port ${config.port}`);
  loggers.server.info(`URL base path: ${URL_BASE_PATH || '(root)'}`);
  loggers.server.info(`CORS origins: ${config.corsOrigins.join(', ')}`);
  loggers.server.info(`Environment: ${config.nodeEnv}`);

  if (config.firefly.apiUrl) {
    loggers.server.info(`Firefly III API: ${config.firefly.apiUrl}`);
  } else {
    loggers.server.warn('Firefly III API not configured');
  }

  if (config.ai.provider === 'openai' && config.ai.apiKey) {
    loggers.server.info(`AI: OpenAI configured (model: ${config.ai.model})`);
  } else if (config.ai.provider === 'ollama' && config.ai.apiUrl) {
    loggers.server.info(
      `AI: Ollama configured (url: ${config.ai.apiUrl}, model: ${config.ai.model})`
    );
  } else {
    loggers.server.info('AI not configured (AI features disabled)');
  }

  // Log authentication configuration
  if (config.auth.method === 'none') {
    loggers.server.warn('Authentication: DISABLED (open access)');
  } else {
    loggers.server.info(`Authentication: ${config.auth.method.toUpperCase()}`);
  }

  // Start session store cleanup interval
  startCleanupInterval();

  if (config.fints.productId) {
    void preloadFinTSBankIndex();
  }

  if (process.env.PII_MODEL_PATH) {
    warmupPiiScrubber().catch((err) =>
      loggers.server.warn(`PII model preload failed: ${err instanceof Error ? err.message : String(err)}`)
    );
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  loggers.server.info('SIGTERM received, shutting down gracefully...');
  stopCleanupInterval();
  server.close(() => {
    loggers.server.info('Server closed');
    process.exit(0);
  });
});

export default app;
