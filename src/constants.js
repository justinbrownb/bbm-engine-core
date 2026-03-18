// Shared constants across all BBM content engines and bots

export const MODELS = {
  OPUS: 'claude-opus-4-6',
  SONNET: 'claude-sonnet-4-20250514',
  HAIKU: 'claude-haiku-4-5-20251001',
};

export const API_ENDPOINTS = {
  PLAUSIBLE: 'https://plausible.io/api/v2/query',
};

export const TIMEOUTS = {
  CLAUDE_CALL: 180000,    // 3 minutes
  WP_UPLOAD: 60000,       // 1 minute
  IMAGE_DOWNLOAD: 30000,  // 30 seconds
  HTTP_REQUEST: 15000,    // 15 seconds
};

export const RETRY_CONFIG = {
  maxRetries: 3,
  initialDelayMs: 1000,
  backoffMultiplier: 2,
};

// Performance classification thresholds (can be overridden per engine)
export const DEFAULT_PERFORMANCE_THRESHOLDS = {
  strong: 500,
  average: 100,
  weak: 0,
};
