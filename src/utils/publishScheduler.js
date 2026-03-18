// Publish Scheduler — enforces minimum gap between articles on the same site.
// Uses WordPress scheduled publishing (status: 'future', date_gmt) so articles
// are spaced out even if the engine publishes them all in one burst.
//
// Usage:
//   import { getNextPublishTime, recordPublish } from './publishScheduler.js';
//   const publishTime = getNextPublishTime(state.publishScheduler);
//   // Pass publishTime to wordpress.js as scheduledDate
//   recordPublish(state.publishScheduler, publishTime);

const MIN_GAP_MS = 30 * 60 * 1000; // 30 minutes between articles

/**
 * Get the next available publish time for this site.
 * Returns null if we can publish immediately, or an ISO string for a future time.
 *
 * @param {object} scheduler - state.publishScheduler object
 * @param {number} gapMs - Minimum gap in ms (default 30 min)
 * @returns {string|null} ISO date string for scheduled publish, or null for immediate
 */
export function getNextPublishTime(scheduler, gapMs = MIN_GAP_MS) {
  if (!scheduler?.lastPublishTime) return null; // No history, publish now

  const lastTime = new Date(scheduler.lastPublishTime).getTime();
  const now = Date.now();
  const nextAllowed = lastTime + gapMs;

  if (now >= nextAllowed) {
    return null; // Enough time has passed, publish immediately
  }

  // Need to schedule into the future
  return new Date(nextAllowed).toISOString();
}

/**
 * Record that an article was published (or scheduled) at a given time.
 * Call this after every successful publish.
 *
 * @param {object} scheduler - state.publishScheduler object
 * @param {string|null} publishTime - The scheduled time (ISO string) or null if published now
 */
export function recordPublish(scheduler, publishTime) {
  const time = publishTime || new Date().toISOString();
  scheduler.lastPublishTime = time;
  scheduler.totalScheduled = (scheduler.totalScheduled || 0) + 1;
}

/**
 * Initialize or migrate the scheduler state.
 *
 * @param {object} state - The engine's full state object
 */
export function initScheduler(state) {
  if (!state.publishScheduler) {
    state.publishScheduler = {
      lastPublishTime: null,
      totalScheduled: 0,
    };
  }
}

/**
 * Get publish status and time info for logging/Telegram.
 *
 * @param {string|null} scheduledTime - The time returned by getNextPublishTime
 * @returns {object} { status: 'publish'|'future', dateGmt: string|undefined, logMsg: string }
 */
export function getPublishParams(scheduledTime) {
  if (!scheduledTime) {
    return {
      status: 'publish',
      dateGmt: undefined,
      logMsg: 'Publishing immediately',
    };
  }

  const scheduledDate = new Date(scheduledTime);
  const minsFromNow = Math.round((scheduledDate.getTime() - Date.now()) / 60000);

  return {
    status: 'future',
    dateGmt: scheduledDate.toISOString().replace('Z', ''),
    logMsg: `Scheduled for ${scheduledDate.toISOString()} (${minsFromNow} min from now)`,
  };
}
