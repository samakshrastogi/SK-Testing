import dotenv from "dotenv";

dotenv.config();

const readString = (key: string): string => {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
};

const readOptionalString = (key: string): string | undefined => {
  const value = process.env[key]?.trim();
  return value ? value : undefined;
};

const readNumber = (key: string): number => {
  const value = readString(key);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric environment variable: ${key}`);
  }

  return parsed;
};

const readBoolean = (key: string): boolean => {
  const value = readString(key).toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error(`Invalid boolean environment variable: ${key}`);
  }

  return value === "true";
};

const readList = (key: string): string[] =>
  readString(key)
    .split("|")
    .map((item) => item.trim())
    .filter(Boolean);

const normalizeRoute = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error(`Route environment variable must start with '/': ${trimmed}`);
  }

  return trimmed === "/" ? trimmed : trimmed.replace(/\/+$/, "");
};

export const env = {
  runtime: {
    port: readNumber("PORT"),
    nodeEnv: readString("NODE_ENV"),
    serviceName: readString("SERVICE_NAME"),
    artifactsDir: readString("ARTIFACTS_DIR"),
    artifactsPublicRoute: normalizeRoute(readString("ARTIFACTS_PUBLIC_ROUTE")),
    corsOrigin: readString("CORS_ORIGIN"),
    corsCredentials: readBoolean("CORS_CREDENTIALS"),
    jsonBodyLimit: readString("JSON_BODY_LIMIT"),
    analysisApiRoute: normalizeRoute(readString("API_ANALYSIS_ROUTE")),
  },
  secrets: {
    mongoUri: readString("MONGO_URI"),
  },
  database: {
    maxPoolSize: readNumber("MONGO_MAX_POOL_SIZE"),
    minPoolSize: readNumber("MONGO_MIN_POOL_SIZE"),
    serverSelectionTimeoutMs: readNumber("MONGO_SERVER_SELECTION_TIMEOUT_MS"),
    socketTimeoutMs: readNumber("MONGO_SOCKET_TIMEOUT_MS"),
  },
  crawler: {
    headless: readBoolean("PLAYWRIGHT_HEADLESS"),
    timeoutMs: readNumber("CRAWLER_TIMEOUT_MS"),
    maxPages: readNumber("CRAWLER_MAX_PAGES"),
    maxLinksPerPage: readNumber("CRAWLER_MAX_LINKS_PER_PAGE"),
    maxDepth: readNumber("CRAWLER_MAX_DEPTH"),
    maxInteractionsPerPage: readNumber("CRAWLER_MAX_INTERACTIONS_PER_PAGE"),
    browserExecutablePath: readOptionalString("BROWSER_EXECUTABLE_PATH"),
    browserFallbackExecutablePaths: readList("BROWSER_FALLBACK_EXECUTABLE_PATHS"),
    loadStateTimeoutMs: readNumber("CRAWLER_LOAD_STATE_TIMEOUT_MS"),
    networkIdleTimeoutMs: readNumber("CRAWLER_NETWORK_IDLE_TIMEOUT_MS"),
    settleDelayMs: readNumber("CRAWLER_SETTLE_DELAY_MS"),
    navigationRecoverySettleTimeoutMs: readNumber("CRAWLER_NAVIGATION_RECOVERY_SETTLE_TIMEOUT_MS"),
    extendedGotoTimeoutMs: readNumber("CRAWLER_EXTENDED_GOTO_TIMEOUT_MS"),
    recoveryBlankTimeoutMs: readNumber("CRAWLER_RECOVERY_BLANK_TIMEOUT_MS"),
    recoveryWaitMs: readNumber("CRAWLER_RECOVERY_WAIT_MS"),
    authSessionDetectionTimeoutMs: readNumber("CRAWLER_AUTH_SESSION_DETECTION_TIMEOUT_MS"),
    loginCheckpointTimeoutSeconds: readNumber("LOGIN_CHECKPOINT_TIMEOUT_SECONDS"),
  },
  artifacts: {
    retentionDays: readNumber("ARTIFACT_RETENTION_DAYS"),
    cleanupIntervalMs: readNumber("ARTIFACT_CLEANUP_INTERVAL_MS"),
    cleanupEnabled: readBoolean("ARTIFACT_CLEANUP_ENABLED"),
  },
  analysis: {
    maxConcurrentRuns: readNumber("ANALYSIS_MAX_CONCURRENT_RUNS"),
    progressFlushIntervalMs: readNumber("ANALYSIS_PROGRESS_FLUSH_INTERVAL_MS"),
    logFlushIntervalMs: readNumber("ANALYSIS_LOG_FLUSH_INTERVAL_MS"),
    logBatchSize: readNumber("ANALYSIS_LOG_BATCH_SIZE"),
    interactionBatchSize: readNumber("ANALYSIS_INTERACTION_BATCH_SIZE"),
    leaseHeartbeatIntervalMs: readNumber("ANALYSIS_LEASE_HEARTBEAT_INTERVAL_MS"),
    queuePollIntervalMs: readNumber("ANALYSIS_QUEUE_POLL_INTERVAL_MS"),
    streamHeartbeatIntervalMs: readNumber("ANALYSIS_STREAM_HEARTBEAT_INTERVAL_MS"),
  },
};

export const publicRuntimeEnv = {
  port: env.runtime.port,
  nodeEnv: env.runtime.nodeEnv,
  serviceName: env.runtime.serviceName,
  artifactsDir: env.runtime.artifactsDir,
  artifactsPublicRoute: env.runtime.artifactsPublicRoute,
  corsOrigin: env.runtime.corsOrigin,
  corsCredentials: env.runtime.corsCredentials,
  jsonBodyLimit: env.runtime.jsonBodyLimit,
  analysisApiRoute: env.runtime.analysisApiRoute,
};
