// Health server + event logger for monitoring
// Provides /health endpoint (JSON) and event log for Telegram /logs command

import http from 'http';

const MAX_EVENTS = 100;
const events = [];
const startTime = Date.now();

// Counters
const counters = {
  articlesPublished: 0,
  articlesFailed: 0,
  cyclesRun: 0,
  trendsScanned: 0,
  lastPublishTime: null,
  lastPublishUrl: null,
  lastPublishTitle: null,
  lastCycleTime: null,
  lastError: null,
  lastErrorTime: null,
};

/**
 * Log an event. Types: publish, error, cycle, trend, command, info, warn, strategy
 */
export function log(type, message, data = {}) {
  const entry = {
    time: new Date().toISOString(),
    type,
    message,
    ...data,
  };
  events.push(entry);
  if (events.length > MAX_EVENTS) events.shift();

  // Update counters
  if (type === 'publish') {
    counters.articlesPublished++;
    counters.lastPublishTime = entry.time;
    if (data.url) counters.lastPublishUrl = data.url;
    if (data.title) counters.lastPublishTitle = data.title;
  } else if (type === 'error') {
    counters.articlesFailed++;
    counters.lastError = message;
    counters.lastErrorTime = entry.time;
  } else if (type === 'cycle') {
    counters.cyclesRun++;
    counters.lastCycleTime = entry.time;
  } else if (type === 'trend') {
    counters.trendsScanned++;
  }

  // Also log to console
  const prefix = type === 'error' ? '❌' : type === 'publish' ? '✅' : type === 'cycle' ? '🔄' : type === 'trend' ? '📡' : type === 'strategy' ? '🧠' : type === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`[Health] ${prefix} ${message}`);
}

/**
 * Get recent events (for Telegram /logs command).
 */
export function getRecentEvents(count = 15) {
  return events.slice(-count);
}

/**
 * Get health summary (for Telegram /status enhancement).
 */
export function getHealthSummary() {
  return {
    uptime: Math.round((Date.now() - startTime) / 1000),
    uptimeHuman: formatUptime(Date.now() - startTime),
    ...counters,
    eventCount: events.length,
  };
}

/**
 * Format uptime as human-readable string.
 */
function formatUptime(ms) {
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

// External state provider (set by orchestrator)
let stateProvider = () => ({});

/**
 * Set the state provider function (called from orchestrator to expose engine state).
 */
export function setStateProvider(fn) {
  stateProvider = fn;
}

/**
 * Start the HTTP health server.
 */
export function startHealthServer(appName) {
  const port = process.env.PORT || 3000;

  const server = http.createServer((req, res) => {
    const url = req.url?.split('?')[0];

    if (url === '/health' || url === '/') {
      const summary = getHealthSummary();
      const engineState = stateProvider();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        app: appName,
        status: 'ok',
        timestamp: new Date().toISOString(),
        ...summary,
        engine: engineState,
        recentEvents: events.slice(-10).reverse(),
      }, null, 2));
    } else if (url === '/logs') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        app: appName,
        events: events.slice(-50).reverse(),
      }, null, 2));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  server.listen(port, () => {
    console.log(`[Health] ${appName} health server on port ${port}`);
  });

  server.on('error', (e) => {
    console.error(`[Health] Server error: ${e.message}`);
  });
}
