const env = import.meta.env as Record<string, string | undefined>;

const readString = (key: string): string => {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }

  return value;
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

export const runtime = {
  apiBaseUrl: readString("VITE_API_BASE_URL"),
  analysisApiPath: readString("VITE_ANALYSIS_API_PATH"),
  defaultAnalysisOptions: {
    maxPages: readNumber("VITE_DEFAULT_MAX_PAGES"),
    maxLinksPerPage: readNumber("VITE_DEFAULT_MAX_LINKS_PER_PAGE"),
    maxDepth: readNumber("VITE_DEFAULT_MAX_DEPTH"),
    maxInteractionsPerPage: readNumber("VITE_DEFAULT_MAX_INTERACTIONS_PER_PAGE"),
    respectRobotsTxt: readBoolean("VITE_DEFAULT_RESPECT_ROBOTS_TXT"),
    streamHtmlPreview: readBoolean("VITE_DEFAULT_STREAM_HTML_PREVIEW"),
    crawlProfile: readString("VITE_DEFAULT_CRAWL_PROFILE"),
    strictBehaviorMode: readBoolean("VITE_DEFAULT_STRICT_BEHAVIOR_MODE"),
    promptForLogin: readBoolean("VITE_DEFAULT_PROMPT_FOR_LOGIN"),
    loginPromptEnabled: readBoolean("VITE_LOGIN_CHECKPOINT_ENABLED"),
    loginPromptLabel: readString("VITE_LOGIN_CHECKPOINT_LABEL"),
    loginPromptTimeoutSeconds: readNumber("VITE_LOGIN_CHECKPOINT_TIMEOUT_SECONDS"),
    loginDecisionFallbackMs: readNumber("VITE_LOGIN_DECISION_FALLBACK_MS"),
  },
};
