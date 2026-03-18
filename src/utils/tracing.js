// Cycle Trace Builder — engines use this to record step-by-step traces of each publish cycle
// After a cycle completes, the trace is POSTed to the Prompt API for dashboard visibility
//
// Usage in orchestrator:
//   import { createTraceBuilder, emitTrace } from '@bbm/engine-core/src/utils/tracing.js';
//
//   async function runPublishCycle() {
//     const trace = createTraceBuilder('dmnews');
//
//     const reviewData = await trace.step('performanceReview', async () => {
//       const results = await reviewPerformance();
//       return { articlesReviewed: results.length, strong: 2, average: 1, weak: 1 };
//     });
//
//     const trends = await trace.step('trendDiscovery', async () => {
//       const found = await discoverTrends();
//       return { trendsFound: found.length };
//     });
//
//     // ... more steps
//
//     await emitTrace(trace.build());
//   }

import https from 'https';
import http from 'http';

const PROMPT_API_URL = process.env.PROMPT_API_URL || 'http://localhost:3001';

/**
 * Create a new trace builder for a cycle.
 * @param {string} engine - Engine ID (dmnews, sc, vo, tyb)
 * @returns {TraceBuilder}
 */
export function createTraceBuilder(engine) {
  const cycleId = `${engine}-${new Date().toISOString()}`;
  const startTime = Date.now();

  const steps = {};
  const articles = [];
  let status = 'running';
  let failureReason = null;

  return {
    /**
     * Record a step with timing. The callback runs the actual work.
     * Returns whatever the callback returns (so you can chain data).
     * @param {string} stepName - Step identifier (e.g. 'performanceReview', 'trendDiscovery')
     * @param {Function} fn - Async function to execute. Return value becomes step data.
     * @returns {Promise<*>} Whatever fn() returns
     */
    async step(stepName, fn) {
      const stepStart = Date.now();
      try {
        const result = await fn();
        steps[stepName] = {
          status: 'complete',
          durationMs: Date.now() - stepStart,
          ...(result && typeof result === 'object' ? result : {}),
        };
        return result;
      } catch (e) {
        steps[stepName] = {
          status: 'failed',
          durationMs: Date.now() - stepStart,
          error: e.message,
        };
        throw e; // Re-throw so the orchestrator can handle it
      }
    },

    /**
     * Record an article's per-step details.
     * @param {Object} articleTrace - Article trace object
     */
    addArticle(articleTrace) {
      articles.push(articleTrace);
    },

    /**
     * Mark the cycle as failed.
     * @param {string} reason
     */
    fail(reason) {
      status = 'failed';
      failureReason = reason;
    },

    /**
     * Build the final trace object.
     * @param {Object} [summary] - Additional summary data
     * @returns {Object} Complete trace
     */
    build(summary = {}) {
      if (status === 'running') status = 'complete';

      return {
        cycleId,
        engine,
        startTime: new Date(startTime).toISOString(),
        endTime: new Date().toISOString(),
        durationMs: Date.now() - startTime,
        status,
        failureReason,
        steps,
        articles,
        summary: {
          published: articles.filter(a => a.substeps?.publishing?.status === 'complete').length,
          failed: articles.filter(a => Object.values(a.substeps || {}).some(s => s.status === 'failed')).length,
          ...summary,
        },
      };
    },
  };
}

/**
 * Create an article trace builder for tracking per-article steps.
 * @param {string} title
 * @param {string} author
 * @param {string} [tier]
 * @returns {Object} Article trace builder
 */
export function createArticleTrace(title, author, tier = null) {
  const substeps = {};

  return {
    /**
     * Record a substep with timing.
     */
    async substep(name, fn) {
      const start = Date.now();
      try {
        const result = await fn();
        substeps[name] = {
          status: 'complete',
          durationMs: Date.now() - start,
          ...(result && typeof result === 'object' ? result : {}),
        };
        return result;
      } catch (e) {
        substeps[name] = {
          status: 'failed',
          durationMs: Date.now() - start,
          error: e.message,
        };
        throw e;
      }
    },

    /**
     * Record a substep result directly (without running a function).
     */
    record(name, data) {
      substeps[name] = { status: 'complete', ...data };
    },

    /**
     * Build the article trace.
     * @param {Object} [extra] - Additional article metadata
     */
    build(extra = {}) {
      return {
        title,
        author,
        tier,
        substeps,
        ...extra,
      };
    },
  };
}

/**
 * Send a completed trace to the Prompt API for storage.
 * Fire-and-forget — failures are logged but don't crash the engine.
 * @param {Object} trace - Complete trace from builder.build()
 */
export async function emitTrace(trace) {
  try {
    const url = `${PROMPT_API_URL}/api/traces`;
    await postJSON(url, trace);
    console.log(`[Tracing] Cycle trace emitted: ${trace.cycleId} (${trace.articles.length} articles, ${trace.durationMs}ms)`);
  } catch (e) {
    console.warn(`[Tracing] Failed to emit trace (non-fatal): ${e.message}`);
  }
}

// --- Internal HTTP POST ---

function postJSON(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const lib = urlObj.protocol === 'https:' ? https : http;

    const req = lib.request({
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 10000,
    }, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(body);
    req.end();
  });
}
