export type ProactiveConfig = {
  /** Enable proactive messaging. Default: true. */
  enabled?: boolean;
  /** How often to scan sessions for proactive opportunities (minutes). Default: 5. */
  checkIntervalMinutes?: number;
  /** Start of quiet hours in HH:mm format (user timezone). Default: "22:00". */
  quietHoursStart?: string;
  /** End of quiet hours in HH:mm format (user timezone). Default: "06:00". */
  quietHoursEnd?: string;
  /** Minimum idle minutes before considering a proactive message. Default: 60. */
  minIdleMinutes?: number;
  /** Minimum gap between proactive messages in minutes. Default: 120. */
  minGapMinutes?: number;
  /** Maximum proactive messages per day per session. Default: 6. */
  maxPerDay?: number;
  /** Run a proactive check on gateway startup. Default: true. */
  startupGreeting?: boolean;
};

export const PROACTIVE_DEFAULTS = {
  enabled: true,
  checkIntervalMinutes: 5,
  quietHoursStart: "22:00",
  quietHoursEnd: "06:00",
  minIdleMinutes: 60,
  minGapMinutes: 120,
  maxPerDay: 6,
  startupGreeting: true,
} as const satisfies Required<ProactiveConfig>;
