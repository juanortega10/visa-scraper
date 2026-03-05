import {
  pgTable,
  pgEnum,
  text,
  varchar,
  timestamp,
  integer,
  boolean,
  jsonb,
  date,
  serial,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// ── Enums ──────────────────────────────────────────────

export const botStatusEnum = pgEnum('bot_status', [
  'created',
  'login_required',
  'active',
  'paused',
  'error',
]);

export const proxyProviderEnum = pgEnum('proxy_provider', [
  'direct',
  'brightdata',
  'firecrawl',
  'webshare',
]);


// ── CAS Cache Types ──────────────────────────────────────

export interface CasCacheEntry {
  date: string;       // YYYY-MM-DD
  slots: number;      // available_times.length (-1 = error)
  times: string[];    // ["07:00", "07:15", ...] — only if slots > 0
}

export interface CasCacheData {
  refreshedAt: string;       // ISO 8601
  windowDays: number;        // 21
  totalDates: number;        // dates checked
  fullDates: number;         // dates with 0 slots
  entries: CasCacheEntry[];
}

// ── Bots ───────────────────────────────────────────────

export const bots = pgTable(
  'bots',
  {
    id: serial('id').primaryKey(),
    visaEmail: text('visa_email').notNull(),       // encrypted
    visaPassword: text('visa_password').notNull(),  // encrypted
    scheduleId: varchar('schedule_id', { length: 20 }).notNull(),
    applicantIds: jsonb('applicant_ids').$type<string[]>().notNull(),
    consularFacilityId: varchar('consular_facility_id', { length: 10 }).notNull().default('25'),
    ascFacilityId: varchar('asc_facility_id', { length: 10 }).notNull().default('26'),
    locale: varchar('locale', { length: 10 }).notNull().default('es-co'),
    currentConsularDate: date('current_consular_date'),
    currentConsularTime: varchar('current_consular_time', { length: 5 }),
    currentCasDate: date('current_cas_date'),
    currentCasTime: varchar('current_cas_time', { length: 5 }),
    status: botStatusEnum('status').notNull().default('created'),
    proxyProvider: proxyProviderEnum('proxy_provider').notNull().default('direct'),
    proxyUrls: jsonb('proxy_urls').$type<string[] | null>(),
    isScout: boolean('is_scout').notNull().default(false),
    isSubscriber: boolean('is_subscriber').notNull().default(true),
    userId: varchar('user_id', { length: 20 }),
    activeRunId: varchar('active_run_id', { length: 50 }),
    activeCloudRunId: varchar('active_cloud_run_id', { length: 50 }),
    pollEnvironments: jsonb('poll_environments').$type<string[]>().default(['dev']),
    cloudEnabled: boolean('cloud_enabled').notNull().default(false),
    clerkUserId: varchar('clerk_user_id', { length: 50 }),
    casCacheJson: jsonb('cas_cache_json').$type<CasCacheData | null>(),
    targetDateBefore: date('target_date_before'),                       // hard cutoff: only reschedule to dates < this (YYYY-MM-DD exclusive)
    maxReschedules: integer('max_reschedules'),                         // null = unlimited, e.g. Peru = 2
    rescheduleCount: integer('reschedule_count').notNull().default(0),  // incremented on each successful reschedule
    maxCasGapDays: integer('max_cas_gap_days'),                            // null = default (8), max days between CAS and consular
    pollIntervalSeconds: integer('poll_interval_seconds'),                  // null = locale default; raw delay override (advanced)
    targetPollsPerMin: integer('target_polls_per_min'),                     // null = use pollIntervalSeconds/locale default; auto-computes delay accounting for overhead
    consecutiveErrors: integer('consecutive_errors').notNull().default(0),
    webhookUrl: text('webhook_url'),
    notificationEmail: text('notification_email'),   // operational alerts (all events) — typically the admin
    ownerEmail: text('owner_email'),                  // bot owner — only gets reschedule_success
    activatedAt: timestamp('activated_at'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => [
    index('bots_status_idx').on(table.status),
    index('bots_schedule_idx').on(table.scheduleId),
  ],
);

// ── Excluded Dates ─────────────────────────────────────

export const excludedDates = pgTable(
  'excluded_dates',
  {
    id: serial('id').primaryKey(),
    botId: integer('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    startDate: date('start_date').notNull(),
    endDate: date('end_date').notNull(),
  },
  (table) => [index('excluded_dates_bot_idx').on(table.botId)],
);

// ── Excluded Times ─────────────────────────────────────

export const excludedTimes = pgTable(
  'excluded_times',
  {
    id: serial('id').primaryKey(),
    botId: integer('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    date: date('date'), // null = applies to all dates
    timeStart: varchar('time_start', { length: 5 }).notNull(),
    timeEnd: varchar('time_end', { length: 5 }).notNull(),
  },
  (table) => [index('excluded_times_bot_idx').on(table.botId)],
);

// ── Sessions ───────────────────────────────────────────

export const sessions = pgTable(
  'sessions',
  {
    id: serial('id').primaryKey(),
    botId: integer('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    yatriCookie: text('yatri_cookie').notNull(),       // encrypted
    csrfToken: text('csrf_token'),
    authenticityToken: text('authenticity_token'),
    lastUsedAt: timestamp('last_used_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [uniqueIndex('sessions_bot_idx').on(table.botId)],
);

// ── Poll Logs ──────────────────────────────────────────

export const pollLogs = pgTable(
  'poll_logs',
  {
    id: serial('id').primaryKey(),
    botId: integer('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    earliestDate: date('earliest_date'),
    datesCount: integer('dates_count'),
    responseTimeMs: integer('response_time_ms'),
    topDates: jsonb('top_dates').$type<string[]>(),
    rawDatesCount: integer('raw_dates_count'),
    provider: varchar('provider', { length: 15 }),
    reloginHappened: boolean('relogin_happened'),
    phaseTimings: jsonb('phase_timings').$type<Record<string, number>>(),
    status: varchar('status', { length: 30 }).notNull(), // ok, filtered_out, session_expired, error
    rescheduleResult: varchar('reschedule_result', { length: 30 }), // null=no attempt, success, no_cas_days, no_times, no_cas_times, post_failed, stale_data
    rescheduleDetails: jsonb('reschedule_details').$type<object>(),
    allDates: jsonb('all_dates').$type<Array<{date: string, business_day: boolean}>>(),
    chainId: varchar('chain_id', { length: 10 }), // 'dev' | 'cloud' | null (legacy)
    pollPhase: varchar('poll_phase', { length: 20 }),
    fetchIndex: integer('fetch_index'),
    runId: varchar('run_id', { length: 50 }),
    publicIp: varchar('public_ip', { length: 45 }), // IPv4 or IPv6
    dateChanges: jsonb('date_changes').$type<{ appeared: string[], disappeared: string[] }>(),
    error: text('error'),
    connectionInfo: jsonb('connection_info').$type<{
      proxyAttemptIp?: string | null;  // webshare IP tried before fallback (lost if lastProxyIp reset)
      fallbackHappened?: boolean;      // webshare TCP fail → direct fallback
      fallbackReason?: string;         // ECONNRESET | ETIMEDOUT | ECONNREFUSED | ...
      websharePoolSize?: number;       // IPs disponibles en el pool al momento del request
      errorSource?: 'proxy_infra' | 'embassy_block' | 'proxy_quota';
    }>(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('poll_logs_bot_idx').on(table.botId),
    index('poll_logs_created_idx').on(table.createdAt),
  ],
);

// ── Reschedule Logs ────────────────────────────────────

export const rescheduleLogs = pgTable(
  'reschedule_logs',
  {
    id: serial('id').primaryKey(),
    botId: integer('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    oldConsularDate: date('old_consular_date'),
    oldConsularTime: varchar('old_consular_time', { length: 5 }),
    oldCasDate: date('old_cas_date'),
    oldCasTime: varchar('old_cas_time', { length: 5 }),
    newConsularDate: date('new_consular_date').notNull(),
    newConsularTime: varchar('new_consular_time', { length: 5 }).notNull(),
    newCasDate: date('new_cas_date'),
    newCasTime: varchar('new_cas_time', { length: 5 }),
    success: boolean('success').notNull(),
    dispatchLogId: integer('dispatch_log_id'),
    error: text('error'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('reschedule_logs_bot_idx').on(table.botId)],
);

// ── Dispatch Logs ────────────────────────────────────────

export interface DispatchDetail {
  botId: number;
  currentDate: string;
  targetDate: string;
  improvementDays: number;
  priorityRank: number;
  action: 'attempted' | 'skipped_no_improvement' | 'skipped_excluded' | 'skipped_paused';
  loginMs?: number;
  rescheduleMs?: number;
  result?: 'success' | 'failed' | 'error';
  newDate?: string;
  failReason?: string;
  error?: string;
}

export const dispatchLogs = pgTable(
  'dispatch_logs',
  {
    id: serial('id').primaryKey(),
    scoutBotId: integer('scout_bot_id').notNull(),
    facilityId: varchar('facility_id', { length: 10 }).notNull(),
    availableDates: jsonb('available_dates').$type<string[]>(),
    subscribersConsidered: integer('subscribers_considered').notNull(),
    subscribersAttempted: integer('subscribers_attempted').notNull(),
    subscribersSucceeded: integer('subscribers_succeeded').notNull(),
    subscribersFailed: integer('subscribers_failed').notNull(),
    subscribersSkipped: integer('subscribers_skipped').notNull(),
    details: jsonb('details').$type<DispatchDetail[]>(),
    durationMs: integer('duration_ms'),
    pollLogId: integer('poll_log_id'),
    runId: varchar('run_id', { length: 50 }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('dispatch_logs_scout_idx').on(table.scoutBotId),
    index('dispatch_logs_created_idx').on(table.createdAt),
  ],
);

// ── CAS Slot Change Types ────────────────────────────────

export interface CasSlotChange {
  date: string;          // YYYY-MM-DD
  type: 'appeared' | 'went_full' | 'disappeared' | 'slots_changed';
  oldSlots: number;      // -1 if didn't exist
  newSlots: number;      // -1 if disappeared
  addedTimes?: string[];     // times that appeared (e.g. ["07:00", "07:15"])
  removedTimes?: string[];   // times that disappeared
  confidence?: 'high' | 'low' | 'error';  // error = that date failed in fetch
}

export interface PrefetchReliability {
  totalApiCalls: number;
  successfulCalls: number;
  failedCalls: number;
  failureRate: number;        // 0.0 - 1.0
  reliable: boolean;          // failureRate < 0.3
  failedProbes: string[];     // probe dates that failed getCasDays
  failedTimeFetches: string[];// CAS dates that failed getCasTimes (slots=-1)
}

// ── CAS Prefetch Logs ────────────────────────────────────

export const casPrefetchLogs = pgTable(
  'cas_prefetch_logs',
  {
    id: serial('id').primaryKey(),
    botId: integer('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    totalDates: integer('total_dates').notNull(),
    fullDates: integer('full_dates').notNull(),
    lowDates: integer('low_dates').notNull(),
    durationMs: integer('duration_ms').notNull(),
    requestCount: integer('request_count').notNull(),
    changesJson: jsonb('changes_json').$type<CasSlotChange[] | null>(),
    reliabilityJson: jsonb('reliability_json').$type<PrefetchReliability | null>(),
    error: text('error'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [index('cas_prefetch_logs_bot_idx').on(table.botId)],
);

// ── Auth Logs ────────────────────────────────────────────

export const authLogs = pgTable(
  'auth_logs',
  {
    id: serial('id').primaryKey(),
    email: text('email').notNull(),           // encrypted (AES-256-GCM)
    action: varchar('action', { length: 30 }).notNull(), // 'validate' | 'discover' | 'create_bot'
    locale: varchar('locale', { length: 10 }),
    result: varchar('result', { length: 20 }).notNull(), // 'ok' | 'invalid' | 'error'
    errorMessage: text('error_message'),
    passwordEncrypted: text('password_encrypted'),
    clerkUserId: varchar('clerk_user_id', { length: 50 }),
    ip: varchar('ip', { length: 45 }),
    botId: integer('bot_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('auth_logs_created_idx').on(table.createdAt),
  ],
);

// ── Notification Logs ────────────────────────────────────

export const notificationLogs = pgTable(
  'notification_logs',
  {
    id: serial('id').primaryKey(),
    botId: integer('bot_id')
      .notNull()
      .references(() => bots.id, { onDelete: 'cascade' }),
    event: varchar('event', { length: 50 }).notNull(),       // e.g. reschedule_success
    channel: varchar('channel', { length: 10 }).notNull(),   // 'email' | 'webhook'
    recipient: text('recipient').notNull(),                   // email address or webhook url
    status: varchar('status', { length: 10 }).notNull(),     // 'sent' | 'failed'
    externalId: varchar('external_id', { length: 100 }),     // Resend email ID
    error: text('error'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => [
    index('notification_logs_bot_idx').on(table.botId),
    index('notification_logs_created_idx').on(table.createdAt),
  ],
);

// ── Type exports ───────────────────────────────────────

export type Bot = typeof bots.$inferSelect;
export type NewBot = typeof bots.$inferInsert;
export type Session = typeof sessions.$inferSelect;
export type PollLog = typeof pollLogs.$inferSelect;
export type RescheduleLog = typeof rescheduleLogs.$inferSelect;
export type CasPrefetchLog = typeof casPrefetchLogs.$inferSelect;
export type DispatchLog = typeof dispatchLogs.$inferSelect;
export type AuthLog = typeof authLogs.$inferSelect;
export type NotificationLog = typeof notificationLogs.$inferSelect;
