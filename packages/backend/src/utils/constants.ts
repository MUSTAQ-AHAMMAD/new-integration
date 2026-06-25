/**
 * Integration-state constants — TypeScript equivalent of the Java Constants.java.
 *
 * Used to describe the current state or trigger mode of an integration
 * job or scheduled processor throughout the system.
 */

/** Possible running states for a background integration processor. */
export const IntegrationState = {
  /** The processor is currently executing. */
  RUNNING: 'RUNNING',
  /** The processor is waiting for its next scheduled trigger. */
  IDLE: 'IDLE',
} as const;

export type IntegrationState =
  (typeof IntegrationState)[keyof typeof IntegrationState];

/** Trigger modes for a scheduled job. */
export const TriggerMode = {
  /** Job was launched by the scheduler automatically. */
  AUTOMATIC: 'AUTOMATIC',
  /** Job was launched by an admin via the API / UI. */
  MANUAL: 'MANUAL',
  /** No trigger has been configured or the job is disabled. */
  NONE: 'NONE',
} as const;

export type TriggerMode = (typeof TriggerMode)[keyof typeof TriggerMode];
