/**
 * Shared constants used across the application
 */

/**
 * Creator ID used for sync jobs created by the automatic pipeline scheduler
 */
export const PIPELINE_CREATOR_ID = 'DASHBOARD_PIPELINE' as const;

/**
 * All possible sync job creator IDs
 */
export const SYNC_JOB_CREATORS = {
  PIPELINE: PIPELINE_CREATOR_ID,
  API: 'API' as const,
  DASHBOARD_USER: 'DASHBOARD_USER' as const,
  SYSTEM: 'SYSTEM' as const,
} as const;
