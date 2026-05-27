import { mkdir } from "fs/promises";
import path from "path";
import { chromium, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { env } from "../../config/env";
import { HttpError } from "../../lib/HttpError";
import {
  analyzeAccessibility,
  analyzeVisualRegression,
  buildApiAssertions,
  executeScenarioPacks,
  inferResponseShape,
  runBoundaryAndLimitChecks,
} from "./deepAnalysis";
import type {
  AnalysisRequest,
  ApiAssertion,
  FailureCluster,
  FrontendAnalysis,
  InteractionResult,
  LiveSessionSnapshot,
  NavigationEdge,
  NetworkObservation,
  PageAnalysis,
  ProgressUpdate,
  RuntimeFinding,
} from "../../types/platform";
import { normalizeUrl, sameOrigin, toRoutePath, toRoutePattern } from "../../utils/url";

type PageSnapshot = Omit<PageAnalysis, "url" | "routePath" | "depth" | "previewImageUrl" | "htmlPreview">;
type DetectedInteractiveElement = PageAnalysis["buttons"][number] & { id: string; pageUrl: string };
type CrawlPageEntry = {
  key: string;
  url: string;
  routeKey: string;
  depth: number;
  snapshot: PageSnapshot;
  interactiveElements: DetectedInteractiveElement[];
  previewImageUrl?: string;
  htmlPreview?: string;
  baselineSignature?: string;
};
type CrawlCallbacks = {
  onProgress?: (progress: ProgressUpdate) => Promise<void> | void;
  onPage?: (page: PageAnalysis) => Promise<void> | void;
  onInteraction?: (interaction: InteractionResult) => Promise<void> | void;
  onFailureClusters?: (failureClusters: FailureCluster[]) => Promise<void> | void;
  onWarning?: (message: string) => Promise<void> | void;
  waitForCheckpoint?: (checkpoint: {
    kind?: "manual_auth" | "login_choice";
    label: string;
    instructions: string;
    currentPageUrl: string;
    expiresAt?: string;
    liveSession?: LiveSessionSnapshot;
    loginUrl?: string;
    allowedActions?: Array<"continue_without_login" | "continue_after_login">;
  }) => Promise<"continue_without_login" | "continue_after_login">;
};

type CrawlProfileName = NonNullable<NonNullable<AnalysisRequest["options"]>["crawlProfile"]>;
type ResolvedCrawlProfile = {
  name: Exclude<CrawlProfileName, "auto">;
  maxPages: number;
  maxLinksPerPage: number;
  maxDepth: number;
  maxInteractionsPerPage: number;
  excludePathPatterns: string[];
};

type LoginSurfaceDetection = {
  label: string;
  reason: "password_field" | "login_link";
  loginUrl?: string;
};

const browserCandidates = [
  env.crawler.browserExecutablePath,
  ...env.crawler.browserFallbackExecutablePaths,
].filter((candidate): candidate is string => Boolean(candidate));

const buildArtifactPublicUrl = (...segments: string[]) =>
  `${env.runtime.artifactsPublicRoute}/${segments.map((segment) => segment.replace(/^\/+|\/+$/g, "")).join("/")}`;

const interactionSelector =
  "button, a[href], select, textarea, input:not([type='hidden']):not([type='file']), [role='button']";

const screenshotDirectory = (runId: string) =>
  path.resolve(process.cwd(), env.runtime.artifactsDir, "interaction-failures", runId);

const screenshotUrlFromPath = (runId: string, fileName: string) =>
  buildArtifactPublicUrl("interaction-failures", runId, fileName);

const previewDirectory = (runId: string) =>
  path.resolve(process.cwd(), env.runtime.artifactsDir, "live-previews", runId);

const previewUrlFromPath = (runId: string, fileName: string) =>
  buildArtifactPublicUrl("live-previews", runId, fileName);

const formatCrawlerError = (error: unknown) => {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }

  return typeof error === "string" ? error : "Unknown error";
};

const isTimeoutError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "TimeoutError" || /Timeout \d+ms exceeded/i.test(error.message));

const isClosedTargetError = (error: unknown) =>
  error instanceof Error && /Target page, context or browser has been closed/i.test(error.message);

const isExecutionContextDestroyedError = (error: unknown) =>
  error instanceof Error &&
  (/Execution context was destroyed/i.test(error.message) ||
    /Cannot find context with specified id/i.test(error.message) ||
    /Frame was detached/i.test(error.message));

const withNavigationRetry = async <T>(
  page: Page,
  operation: () => Promise<T>,
  fallback: () => T | Promise<T>,
  attempts = 3,
): Promise<T> => {
  let lastError: unknown;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isExecutionContextDestroyedError(error)) {
        throw error;
      }

      await waitForPageSettled(page, Math.min(env.crawler.timeoutMs, env.crawler.navigationRecoverySettleTimeoutMs)).catch(() => undefined);
    }
  }

  if (isExecutionContextDestroyedError(lastError)) {
    return await fallback();
  }

  throw lastError instanceof Error ? lastError : new Error("Page operation failed after retries");
};

const getSafePageTitle = (page: Page) => withNavigationRetry(page, () => page.title(), () => "");

const getSafePageContent = (page: Page) => withNavigationRetry(page, () => page.content(), () => "");

const waitForPageSettled = async (page: Page, timeoutMs = env.crawler.timeoutMs) => {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState("load", { timeout: Math.min(timeoutMs, env.crawler.loadStateTimeoutMs) }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, env.crawler.networkIdleTimeoutMs) }).catch(() => undefined);
  await page.waitForTimeout(env.crawler.settleDelayMs).catch(() => undefined);
};

const hasUsefulNavigationState = async (page: Page, url: string) => {
  const currentUrl = page.url();
  const hasUsefulNavigation =
    currentUrl !== "about:blank" &&
    (currentUrl === url ||
      currentUrl.startsWith(`${url}/`) ||
      currentUrl.startsWith(`${url}?`) ||
      currentUrl.startsWith(`${url}#`));

  const hasDocument = await withNavigationRetry(
    page,
    () => page.evaluate(() => document.readyState !== "loading" || Boolean(document.body?.innerHTML?.trim())),
    () => false,
  ).catch(() => false);

  return hasUsefulNavigation || hasDocument;
};

const getNavigationCandidates = (rawUrl: string) => {
  const candidates = [rawUrl];
  try {
    const parsed = new URL(rawUrl);
    if (parsed.hostname === "youtube.com") {
      candidates.push(`https://www.youtube.com${parsed.pathname}${parsed.search}${parsed.hash}`);
    }
  } catch {
    return candidates;
  }

  return Array.from(new Set(candidates));
};

const gotoStable = async (page: Page, url: string, timeoutMs = env.crawler.timeoutMs) => {
  const candidates = getNavigationCandidates(url);
  let lastError: unknown;

  for (const candidate of candidates) {
    for (const attemptTimeoutMs of [timeoutMs, Math.max(timeoutMs * 2, env.crawler.extendedGotoTimeoutMs)]) {
      try {
        await page.goto(candidate, {
          waitUntil: "commit",
          timeout: attemptTimeoutMs,
        });
        await waitForPageSettled(page, attemptTimeoutMs);
        return;
      } catch (error) {
        lastError = error;
        if (!isTimeoutError(error)) {
          throw error;
        }

        const hasUsefulState = await hasUsefulNavigationState(page, candidate);
        if (hasUsefulState) {
          await waitForPageSettled(page, attemptTimeoutMs);
          return;
        }

        await page.goto("about:blank", { waitUntil: "commit", timeout: env.crawler.recoveryBlankTimeoutMs }).catch(() => undefined);
        await page.waitForTimeout(env.crawler.recoveryWaitMs).catch(() => undefined);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error(`Unable to navigate to ${url}`);
};

const launchBrowser = async (headless: boolean) => {
  const candidates = browserCandidates.length > 0 ? browserCandidates : [undefined];
  let lastError: unknown;

  for (const executablePath of candidates) {
    try {
      return await chromium.launch({
        headless,
        executablePath,
        ignoreDefaultArgs: ["--enable-automation"],
        args: [
          "--disable-blink-features=AutomationControlled",
          "--disable-dev-shm-usage",
          "--no-default-browser-check",
          "--disable-infobars",
        ],
      });
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to launch Chromium");
};

const getPageSignature = async (page: Page) =>
  withNavigationRetry(
    page,
    () =>
      page.evaluate(() => {
        const text = (document.body?.innerText ?? "").replace(/\s+/g, " ").trim();
        const rootHtml = document.documentElement?.outerHTML ?? "";
        return JSON.stringify({
          title: document.title,
          path: window.location.pathname,
          textLength: text.length,
          textSample: text.slice(0, 320),
          domLength: rootHtml.length,
          nodeCount: document.querySelectorAll("*").length,
        });
      }),
    () =>
      JSON.stringify({
        title: "",
        path: new URL(page.url()).pathname,
        textLength: 0,
        textSample: "",
        domLength: 0,
        nodeCount: 0,
      }),
  );

const getDomSnippet = async (page: Page) =>
  withNavigationRetry(
    page,
    () => page.evaluate(() => (document.body?.innerText ?? "").replace(/\s+/g, " ").trim().slice(0, 600)),
    () => "",
  );

const matchAllowedDomain = (target: URL, allowlist: string[]) =>
  allowlist.length === 0 ||
  allowlist.some((domain) => target.hostname === domain || target.hostname.endsWith(`.${domain}`));

const shouldExcludeUrl = (target: URL, patterns: string[]) =>
  patterns.some((pattern) => {
    try {
      return new RegExp(pattern, "i").test(target.pathname);
    } catch {
      return target.pathname.includes(pattern);
    }
  });

const defaultExcludePatternsForHost = (hostname: string) => {
  if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
    return [
      "^/watch",
      "^/redirect",
      "^/hashtag/",
      "^/shorts/[^/]+$",
      "^/@[^/]+/(shorts|videos|streams|community|playlists)$",
    ];
  }

  return [];
};

const detectProfileName = (request: AnalysisRequest, baseUrl: URL): ResolvedCrawlProfile["name"] => {
  const requested = request.options?.crawlProfile;
  if (requested && requested !== "auto") {
    return requested;
  }

  if (baseUrl.hostname === "youtube.com" || baseUrl.hostname.endsWith(".youtube.com")) {
    return "youtube";
  }

  if (request.auth?.login || request.auth?.storageStatePath) {
    return "auth-heavy";
  }

  const hostname = baseUrl.hostname.toLowerCase();
  if (/(shop|store|cart|checkout|product)/.test(hostname)) {
    return "ecommerce";
  }

  if (/(admin|dashboard|console|portal|app)/.test(hostname)) {
    return "dashboard";
  }

  return "generic";
};

const resolveCrawlProfile = (request: AnalysisRequest, baseUrl: URL): ResolvedCrawlProfile => {
  const name = detectProfileName(request, baseUrl);
  const requested = request.options ?? {};
  const defaults: Record<ResolvedCrawlProfile["name"], Omit<ResolvedCrawlProfile, "name">> = {
    generic: {
      maxPages: env.crawler.maxPages,
      maxLinksPerPage: env.crawler.maxLinksPerPage,
      maxDepth: env.crawler.maxDepth,
      maxInteractionsPerPage: env.crawler.maxInteractionsPerPage,
      excludePathPatterns: [],
    },
    youtube: {
      maxPages: 12,
      maxLinksPerPage: 40,
      maxDepth: 2,
      maxInteractionsPerPage: 80,
      excludePathPatterns: defaultExcludePatternsForHost(baseUrl.hostname),
    },
    ecommerce: {
      maxPages: 30,
      maxLinksPerPage: 60,
      maxDepth: 4,
      maxInteractionsPerPage: 120,
      excludePathPatterns: ["logout", "signout", "delete", "remove-account"],
    },
    dashboard: {
      maxPages: 24,
      maxLinksPerPage: 50,
      maxDepth: 5,
      maxInteractionsPerPage: 140,
      excludePathPatterns: ["logout", "signout", "delete", "destroy", "remove"],
    },
    "auth-heavy": {
      maxPages: 20,
      maxLinksPerPage: 40,
      maxDepth: 4,
      maxInteractionsPerPage: 100,
      excludePathPatterns: ["logout", "signout", "delete", "destroy", "remove"],
    },
  };

  const profileDefaults = defaults[name];

  return {
    name,
    maxPages: requested.maxPages ?? profileDefaults.maxPages,
    maxLinksPerPage: requested.maxLinksPerPage ?? profileDefaults.maxLinksPerPage,
    maxDepth: requested.maxDepth ?? profileDefaults.maxDepth,
    maxInteractionsPerPage: requested.maxInteractionsPerPage ?? profileDefaults.maxInteractionsPerPage,
    excludePathPatterns: [...profileDefaults.excludePathPatterns, ...(requested.excludePathPatterns ?? [])],
  };
};

const normalizeHtmlPreview = async (page: Page, pageUrl: string) => {
  const content = await getSafePageContent(page);
  const withoutScripts = content.replace(/<script[\s\S]*?<\/script>/gi, "");
  const baseTag = `<base href="${pageUrl}">`;
  if (withoutScripts.includes("<head>")) {
    return withoutScripts.replace("<head>", `<head>${baseTag}`);
  }

  return `${baseTag}${withoutScripts}`;
};

const annotateAndExtractInteractiveElements = async (
  page: Page,
  pageUrl: string,
  pageKey: string,
): Promise<DetectedInteractiveElement[]> =>
  withNavigationRetry(
    page,
    () =>
      page.evaluate(
        ({ selector, pageUrl: currentPageUrl, pageKey: currentPageKey }) => {
          const isVisible = (element: Element): boolean => {
            const htmlElement = element as HTMLElement;
            const style = window.getComputedStyle(htmlElement);
            const rect = htmlElement.getBoundingClientRect();
            const disabled =
              (htmlElement as HTMLInputElement).disabled ||
              htmlElement.getAttribute("aria-disabled") === "true";

            return (
              !disabled &&
              style.visibility !== "hidden" &&
              style.display !== "none" &&
              rect.width > 0 &&
              rect.height > 0 &&
              !htmlElement.hidden &&
              htmlElement.getAttribute("aria-hidden") !== "true"
            );
          };

          const createSafeSelector = (element: Element): string => {
            const typedElement = element as HTMLElement;
            const escapedId = typedElement.id ? `#${CSS.escape(typedElement.id)}` : "";
            if (escapedId) {
              return escapedId;
            }

            const testId = typedElement.getAttribute("data-testid");
            if (testId) {
              return `[data-testid="${testId}"]`;
            }

            const name = typedElement.getAttribute("name");
            if (name) {
              return `${typedElement.tagName.toLowerCase()}[name="${name}"]`;
            }

            const ariaLabel = typedElement.getAttribute("aria-label");
            if (ariaLabel) {
              return `${typedElement.tagName.toLowerCase()}[aria-label="${ariaLabel}"]`;
            }

            return typedElement.tagName.toLowerCase();
          };

          const textOf = (element: Element) =>
            (element.textContent ?? (element as HTMLInputElement).value ?? "")
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, 140);

          return Array.from(document.querySelectorAll(selector))
            .filter(isVisible)
            .map((element, index) => {
              const typedElement = element as HTMLInputElement;
              const id = `${currentPageKey}_btn_${index + 1}`;
              (element as HTMLElement).setAttribute("data-sk-interaction-id", id);

              return {
                id,
                pageUrl: currentPageUrl,
                tag: element.tagName.toLowerCase(),
                text: textOf(element),
                selector: createSafeSelector(element),
                href: element.getAttribute("href") ?? undefined,
                type: typedElement.type || undefined,
                role: element.getAttribute("role") ?? undefined,
                required: typedElement.required || undefined,
                disabled: typedElement.disabled || undefined,
              };
            });
        },
        { selector: interactionSelector, pageUrl, pageKey },
      ),
    () => [],
  );

const scrapePage = async (
  page: Page,
  pageUrl: string,
  pageKey: string,
  maxLinksPerPage: number,
): Promise<{ snapshot: PageSnapshot; interactiveElements: DetectedInteractiveElement[]; htmlPreview?: string }> => {
  const interactiveElements = await annotateAndExtractInteractiveElements(page, pageUrl, pageKey);

  const forms = await withNavigationRetry(
    page,
    () =>
      page.evaluate(() => {
        const createSafeSelector = (element: Element): string => {
          const typedElement = element as HTMLElement;
          const escapedId = typedElement.id ? `#${CSS.escape(typedElement.id)}` : "";
          if (escapedId) {
            return escapedId;
          }

          const name = typedElement.getAttribute("name");
          if (name) {
            return `${typedElement.tagName.toLowerCase()}[name="${name}"]`;
          }

          return typedElement.tagName.toLowerCase();
        };

        return Array.from(document.querySelectorAll("form")).map((form) => ({
          selector: createSafeSelector(form),
          method: form.getAttribute("method")?.toUpperCase() ?? "GET",
          action: form.getAttribute("action") ?? "",
          fields: Array.from(form.querySelectorAll("input, textarea, select")).map((field) => {
            const typedField = field as HTMLInputElement;
            return {
              name: typedField.name || typedField.id || typedField.type || field.tagName.toLowerCase(),
              selector: createSafeSelector(field),
              type: typedField.type || field.tagName.toLowerCase(),
              required: typedField.required,
              placeholder: typedField.placeholder || undefined,
            };
          }),
        }));
      }),
    () => [],
  );

  const headings = await withNavigationRetry(
    page,
    () =>
      page.evaluate(() =>
        Array.from(document.querySelectorAll("h1, h2, h3"))
          .map((heading) => (heading.textContent ?? "").replace(/\s+/g, " ").trim())
          .filter(Boolean)
          .slice(0, 8),
      ),
    () => [],
  );

  const buttons = interactiveElements.filter((element) => element.tag === "button" || element.role === "button");
  const links = interactiveElements.filter((element) => element.tag === "a");
  const inputs = interactiveElements.filter((element) => element.tag === "input");

  return {
    snapshot: {
      title: await getSafePageTitle(page),
      headings,
      buttons,
      links,
      inputs,
      forms,
      discoveredLinks: links
        .map((link) => link.href)
        .filter((href): href is string => Boolean(href))
        .slice(0, maxLinksPerPage),
      interactionNotes: [`Detected ${interactiveElements.length} visible interactive elements on the page`],
    },
    interactiveElements,
    htmlPreview: await normalizeHtmlPreview(page, pageUrl).catch(() => undefined),
  };
};

const attachNetworkTracking = (
  context: BrowserContext,
  observations: NetworkObservation[],
  baseUrl: URL,
) => {
  const started = new Map<string, { startedAt: number; pageUrl?: string }>();

  context.on("request", (request) => {
    const url = request.url();
    if (!sameOrigin(baseUrl, url)) {
      return;
    }

    let pageUrl: string | undefined;
    try {
      pageUrl = request.frame()?.url() ?? undefined;
    } catch {
      pageUrl = undefined;
    }

    started.set(request.url(), {
      startedAt: Date.now(),
      pageUrl,
    });
  });

  context.on("response", async (response) => {
    const url = response.url();
    if (!sameOrigin(baseUrl, url)) {
      return;
    }

    const request = response.request();
    const startedEntry = started.get(url);
    let pageUrl: string | undefined;
    try {
      pageUrl = response.frame()?.url() ?? undefined;
    } catch {
      pageUrl = undefined;
    }
    const shape = await inferResponseShape(response).catch(() => ({
      contentType: undefined,
      responseShape: undefined as string[] | undefined,
    }));

    observations.push({
      url,
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
      pageUrl: pageUrl ?? startedEntry?.pageUrl,
      latencyMs: startedEntry ? Date.now() - startedEntry.startedAt : undefined,
      contentType: shape.contentType,
      responseShape: shape.responseShape,
    });
    started.delete(url);
  });

  context.on("requestfailed", (request) => {
    const url = request.url();
    if (!sameOrigin(baseUrl, url)) {
      return;
    }

    const startedEntry = started.get(url);
    observations.push({
      url,
      method: request.method(),
      resourceType: request.resourceType(),
      pageUrl: startedEntry?.pageUrl,
      failed: true,
      failureText: request.failure()?.errorText,
      latencyMs: startedEntry ? Date.now() - startedEntry.startedAt : undefined,
    });
    started.delete(url);
  });
};

const buildCoverageReport = (results: InteractionResult[], total: number) => {
  const passed = results.filter((result) => result.result === "PASS").length;
  const failed = results.length - passed;

  return {
    total_buttons: total,
    tested: results.length,
    passed,
    failed,
    coverage: total === 0 ? "0%" : `${Math.round((results.length / total) * 100)}%`,
  };
};

const uniqueFindings = (findings: RuntimeFinding[]) => {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.type}:${finding.pageUrl}:${finding.summary}:${finding.details}`;
    if (seen.has(key)) {
      return false;
    }

    seen.add(key);
    return true;
  });
};

const restorePageState = async (page: Page, pageUrl: string) => {
  await gotoStable(page, pageUrl, env.crawler.timeoutMs);
};

const capturePreviewImage = async ({
  page,
  runId,
  fileName,
}: {
  page: Page;
  runId: string;
  fileName: string;
}) => {
  try {
    const folder = previewDirectory(runId);
    await mkdir(folder, { recursive: true });
    const outputPath = path.join(folder, fileName);
    await page.screenshot({
      path: outputPath,
      fullPage: false,
    });
    return previewUrlFromPath(runId, fileName);
  } catch {
    return undefined;
  }
};

const readRobotsRules = async (baseUrl: URL, enabled: boolean) => {
  if (!enabled) {
    return [];
  }

  try {
    const response = await fetch(new URL("/robots.txt", baseUrl.origin));
    if (!response.ok) {
      return [];
    }

    const content = await response.text();
    const rules: string[] = [];
    let applies = false;

    content.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (/^user-agent:/i.test(trimmed)) {
        applies = trimmed.toLowerCase() === "user-agent: *";
      } else if (applies && /^disallow:/i.test(trimmed)) {
        const value = trimmed.split(":")[1]?.trim();
        if (value) {
          rules.push(value);
        }
      }
    });

    return rules;
  } catch {
    return [];
  }
};

const isRobotsAllowed = (target: URL, disallowRules: string[]) =>
  !disallowRules.some((rule) => rule !== "/" && target.pathname.startsWith(rule));

const toPageAnalysis = (entry: CrawlPageEntry): PageAnalysis => ({
  ...entry.snapshot,
  url: entry.url,
  routePath: entry.routeKey,
  depth: entry.depth,
  previewImageUrl: entry.previewImageUrl,
  htmlPreview: entry.htmlPreview,
});

const buildLiveSession = ({
  url,
  title,
  html,
  previewImageUrl,
  consoleEvents,
  networkRequests,
}: {
  url: string;
  title: string;
  html?: string;
  previewImageUrl?: string;
  consoleEvents: string[];
  networkRequests: NetworkObservation[];
}): LiveSessionSnapshot => ({
  url,
  title,
  html,
  previewImageUrl,
  capturedAt: new Date().toISOString(),
  consoleEvents: consoleEvents.slice(-8),
  networkEvents: networkRequests.slice(-8).map((item) => `${item.method} ${toRoutePath(item.url)}`),
});

const detectLoginSurface = async (page: Page): Promise<LoginSurfaceDetection | null> =>
  withNavigationRetry(
    page,
    () =>
      page.evaluate(() => {
        const normalize = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
        const loginPattern = /\b(log ?in|sign ?in|account|continue with email|continue with google)\b/i;
        const passwordField = document.querySelector(
          "input[type='password'], input[autocomplete='current-password'], input[autocomplete='new-password']",
        );
        if (passwordField) {
          const form = passwordField.closest("form");
          const submitControl = form?.querySelector("button, input[type='submit']");
          const label =
            normalize(submitControl?.textContent) ||
            normalize((submitControl as HTMLInputElement | null)?.value) ||
            normalize(document.title) ||
            "Login form detected";
          return {
            label,
            reason: "password_field" as const,
          };
        }

        const candidates = Array.from(document.querySelectorAll("a[href], button, [role='button']"));
        for (const candidate of candidates) {
          const text =
            normalize(candidate.textContent) ||
            normalize(candidate.getAttribute("aria-label")) ||
            normalize(candidate.getAttribute("title"));
          if (!text || !loginPattern.test(text)) {
            continue;
          }

          return {
            label: text,
            reason: "login_link" as const,
            loginUrl: candidate instanceof HTMLAnchorElement ? candidate.href : undefined,
          };
        }

        return null;
      }),
    () => null,
  );

const waitForAuthenticatedSession = async ({
  page,
  timeoutMs,
}: {
  page: Page;
  timeoutMs: number;
}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const loginSurface = await detectLoginSurface(page).catch(() => null);
    if (!loginSurface) {
      await waitForPageSettled(page, Math.min(env.crawler.timeoutMs, env.crawler.networkIdleTimeoutMs)).catch(() => undefined);
      return true;
    }

    await page.waitForTimeout(750).catch(() => undefined);
  }

  return false;
};

const maybePauseForDetectedLogin = async ({
  page,
  request,
  runId,
  networkRequests,
  consoleEvents,
  callbacks,
  promptState,
}: {
  page: Page;
  request: AnalysisRequest;
  runId: string;
  networkRequests: NetworkObservation[];
  consoleEvents: string[];
  callbacks?: CrawlCallbacks;
  promptState: { handled: boolean };
}) => {
  if (promptState.handled || !request.options?.promptForLogin || request.auth?.login || !callbacks?.waitForCheckpoint) {
    return;
  }

  const detection = await detectLoginSurface(page).catch(() => null);
  if (!detection) {
    return;
  }

  promptState.handled = true;
  const originalUrl = page.url();
  let movedToLoginPage = false;

  if (detection.loginUrl && detection.loginUrl !== originalUrl) {
    try {
      await gotoStable(page, detection.loginUrl, env.crawler.timeoutMs);
      movedToLoginPage = true;
    } catch {
      movedToLoginPage = false;
    }
  }

  const loginPrompt = request.options.loginPrompt;
  const timeoutSeconds = loginPrompt?.timeoutSeconds ?? env.crawler.loginCheckpointTimeoutSeconds;
  const previewImageUrl = await capturePreviewImage({
    page,
    runId,
    fileName: "login-choice.png",
  });
  const html = request.options?.streamHtmlPreview === false ? undefined : await normalizeHtmlPreview(page, page.url());
  const liveSession = buildLiveSession({
    url: page.url(),
    title: await getSafePageTitle(page),
    html,
    previewImageUrl,
    consoleEvents,
    networkRequests,
  });

  const action = await callbacks.waitForCheckpoint({
    kind: "login_choice",
    label: loginPrompt?.checkpointLabel ?? "Login detected on this website",
    instructions:
      loginPrompt?.instructions ??
      `Detected a login surface (${detection.label || detection.reason}). Continue without login to test public flows, or continue with login to open the detected login page.`,
    currentPageUrl: page.url(),
    expiresAt: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
    liveSession,
    loginUrl: page.url(),
    allowedActions: ["continue_without_login", "continue_after_login"],
  });

  if (action === "continue_without_login" && movedToLoginPage) {
    await gotoStable(page, originalUrl, env.crawler.timeoutMs).catch(() => undefined);
  } else {
    await waitForPageSettled(page, Math.min(env.crawler.timeoutMs, env.crawler.navigationRecoverySettleTimeoutMs)).catch(() => undefined);
  }
};

const getInteractionAction = (element: DetectedInteractiveElement): InteractionResult["action"] => {
  if (element.tag === "select") {
    return "select";
  }

  if (element.tag === "textarea") {
    return "fill";
  }

  if (element.tag === "input") {
    const type = element.type?.toLowerCase() ?? "text";
    if (type === "checkbox" || type === "radio") {
      return "check";
    }
    if (["text", "search", "email", "password", "url", "tel", "number"].includes(type)) {
      return "fill";
    }
  }

  return "click";
};

const captureElementState = async (page: Page, interactionId: string) =>
  withNavigationRetry(
    page,
    () =>
      page.evaluate((id) => {
        const element = document.querySelector(`[data-sk-interaction-id="${id}"]`) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | HTMLSelectElement
          | HTMLElement
          | null;

        if (!element) {
          return {
            exists: false,
            active: false,
          };
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const activeElement = document.activeElement as HTMLElement | null;
        const inputElement = element as HTMLInputElement;
        const selectElement = element as HTMLSelectElement;

        return {
          exists: true,
          active: activeElement === element,
          visible: style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0,
          checked: "checked" in inputElement ? Boolean(inputElement.checked) : undefined,
          value:
            "value" in inputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
              ? String((inputElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value ?? "").slice(0, 120)
              : undefined,
          valueLength:
            "value" in inputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement
              ? String((inputElement as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement).value ?? "").length
              : undefined,
          expanded: element.getAttribute("aria-expanded") ?? undefined,
          pressed: element.getAttribute("aria-pressed") ?? undefined,
          disabled: "disabled" in inputElement ? Boolean(inputElement.disabled) : undefined,
          selectedIndex: element instanceof HTMLSelectElement ? selectElement.selectedIndex : undefined,
        };
      }, interactionId),
    () => ({
      exists: false,
      active: false,
    }),
  );

const didElementStateChange = (beforeState: Awaited<ReturnType<typeof captureElementState>>, afterState: Awaited<ReturnType<typeof captureElementState>>) =>
  JSON.stringify(beforeState) !== JSON.stringify(afterState);

const collectPassReasons = (signals: {
  urlChanged: boolean;
  domChanged: boolean;
  apiCallTriggered: boolean;
  consoleTriggered: boolean;
  elementStateChanged: boolean;
  hoverChanged: boolean;
  keyboardTriggered: boolean;
  dialogOpened: boolean;
  popupOpened: boolean;
  downloadTriggered: boolean;
}) =>
  [
    signals.urlChanged ? "url" : null,
    signals.elementStateChanged ? "state" : null,
    signals.domChanged ? "dom" : null,
    signals.apiCallTriggered ? "network" : null,
    signals.consoleTriggered ? "console" : null,
    signals.hoverChanged ? "hover" : null,
    signals.keyboardTriggered ? "keyboard" : null,
    signals.dialogOpened ? "dialog" : null,
    signals.popupOpened ? "popup" : null,
    signals.downloadTriggered ? "download" : null,
  ].filter((value): value is string => Boolean(value));

const buildFailureClusters = (results: InteractionResult[]): FailureCluster[] => {
  const failures = results.filter((item) => item.result === "FAIL");
  const groups = new Map<string, InteractionResult[]>();

  failures.forEach((failure) => {
    const key = `${failure.issueSummary ?? failure.error ?? "Unknown issue"}::${failure.selector}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(failure);
    groups.set(key, bucket);
  });

  return Array.from(groups.entries()).map(([key, clusterResults], index) => {
    const lead = clusterResults[0];
    const pages = Array.from(new Set(clusterResults.map((item) => item.pageUrl)));
    const summary = key.split("::")[0];

    return {
      clusterId: `cluster_${index + 1}`,
      title: `Repeated issue: ${lead.text || lead.selector}`,
      summary,
      occurrences: clusterResults.length,
      pages,
      interactionIds: clusterResults.map((item) => item.buttonId),
      screenshotUrl: lead.screenshotUrl,
      suggestions: [
        "Verify the interaction handler executes on every affected page instance.",
        "Add explicit user feedback when the action starts and completes.",
        "Review repeated failures as one defect to avoid duplicate fixes.",
      ],
    };
  });
};

const discoverConnectedPages = async ({
  page,
  baseUrl,
  maxPages,
  maxDepth,
  maxLinksPerPage,
  runId,
  domainAllowlist,
  excludePathPatterns,
  respectRobotsTxt,
  networkRequests,
  consoleEvents,
  maybeHandleLoginSurface,
  onDiscoveredPage,
  onWarning,
}: {
  page: Page;
  baseUrl: URL;
  maxPages: number;
  maxDepth: number;
  maxLinksPerPage: number;
  runId: string;
  domainAllowlist: string[];
  excludePathPatterns: string[];
  respectRobotsTxt: boolean;
  networkRequests: NetworkObservation[];
  consoleEvents: string[];
  maybeHandleLoginSurface?: () => Promise<void>;
  onDiscoveredPage?: (pages: CrawlPageEntry[], latest: CrawlPageEntry) => Promise<void> | void;
  onWarning?: (message: string) => Promise<void> | void;
}): Promise<CrawlPageEntry[]> => {
  const queue = [{ url: baseUrl.toString(), depth: 0, routeKey: toRoutePattern(baseUrl.toString()) }];
  const visitedUrls = new Set<string>();
  const visitedRoutes = new Set<string>();
  const queuedRoutes = new Set(queue.map((item) => item.routeKey));
  const discoveredPages: CrawlPageEntry[] = [];
  const disallowRules = await readRobotsRules(baseUrl, respectRobotsTxt);

  while (queue.length > 0 && discoveredPages.length < maxPages) {
    const next = queue.shift();
    if (!next || visitedRoutes.has(next.routeKey) || visitedUrls.has(next.url)) {
      continue;
    }

    queuedRoutes.delete(next.routeKey);
    visitedUrls.add(next.url);
    visitedRoutes.add(next.routeKey);
    await gotoStable(page, next.url, env.crawler.timeoutMs);
    await maybeHandleLoginSurface?.();

    const pageKey = `p${discoveredPages.length + 1}`;
    const scraped = await scrapePage(page, next.url, pageKey, maxLinksPerPage);
    const baselineSignature = await getPageSignature(page);
    const previewImageUrl = await capturePreviewImage({
      page,
      runId,
      fileName: `${pageKey}.png`,
    });

    const entry: CrawlPageEntry = {
      key: pageKey,
      url: next.url,
      routeKey: next.routeKey,
      depth: next.depth,
      snapshot: scraped.snapshot,
      interactiveElements: scraped.interactiveElements.map((item) => ({ ...item })),
      previewImageUrl,
      htmlPreview: scraped.htmlPreview,
      baselineSignature,
    };

    discoveredPages.push(entry);
    await onDiscoveredPage?.(discoveredPages, entry);

    if (next.depth >= maxDepth) {
      continue;
    }

    for (const href of scraped.snapshot.discoveredLinks) {
      const absoluteUrl = new URL(href, next.url);
      const absolute = absoluteUrl.toString();
      const allowed =
        (sameOrigin(baseUrl, absolute) || matchAllowedDomain(absoluteUrl, domainAllowlist)) &&
        matchAllowedDomain(absoluteUrl, domainAllowlist);

      if (!allowed) {
        continue;
      }

      if (shouldExcludeUrl(absoluteUrl, excludePathPatterns)) {
        await onWarning?.(`Skipped excluded path ${absoluteUrl.pathname}`);
        continue;
      }

      if (!isRobotsAllowed(absoluteUrl, disallowRules)) {
        await onWarning?.(`Skipped robots-disallowed path ${absoluteUrl.pathname}`);
        continue;
      }

      const routeKey = toRoutePattern(absolute);
      if (visitedRoutes.has(routeKey) || queuedRoutes.has(routeKey)) {
        continue;
      }

      if (!visitedUrls.has(absolute) && !queue.some((item) => item.url === absolute)) {
        queue.push({ url: absolute, depth: next.depth + 1, routeKey });
        queuedRoutes.add(routeKey);
      }
    }

  }

  return discoveredPages;
};

const prepareAuth = async ({
  page,
  context,
  request,
  runId,
  networkRequests,
  consoleEvents,
  callbacks,
}: {
  page: Page;
  context: BrowserContext;
  request: AnalysisRequest;
  runId: string;
  networkRequests: NetworkObservation[];
  consoleEvents: string[];
  callbacks?: CrawlCallbacks;
}) => {
  if (request.auth?.cookies?.length) {
    await context.addCookies(request.auth.cookies);
  }

  const login = request.auth?.login;
  if (!login?.url) {
    return;
  }

  await gotoStable(page, login.url, env.crawler.timeoutMs);

  const previewImageUrl = await capturePreviewImage({
    page,
    runId,
    fileName: "auth-checkpoint.png",
  });
  const html = request.options?.streamHtmlPreview === false ? undefined : await normalizeHtmlPreview(page, page.url());
  const liveSession = buildLiveSession({
    url: page.url(),
    title: await getSafePageTitle(page),
    html,
    previewImageUrl,
    consoleEvents,
    networkRequests,
  });

  if (login.manualCheckpoint?.enabled && callbacks?.waitForCheckpoint) {
    const autoAuthenticated = await waitForAuthenticatedSession({
      page,
      timeoutMs: env.crawler.authSessionDetectionTimeoutMs,
    }).catch(() => false);
    if (autoAuthenticated) {
      await callbacks.onWarning?.(
        `Login session at ${toRoutePath(page.url())} appears authenticated already, skipping manual login checkpoint.`,
      );
    } else {
    const loginSurface = await detectLoginSurface(page).catch(() => null);
    const appearsAuthenticated = !loginSurface;
    if (appearsAuthenticated) {
      await callbacks.onWarning?.(
        `Login session at ${toRoutePath(page.url())} appears authenticated already, skipping manual login checkpoint.`,
      );
    } else {
    const timeoutSeconds = login.manualCheckpoint.timeoutSeconds ?? env.crawler.loginCheckpointTimeoutSeconds;
    await callbacks.waitForCheckpoint({
      kind: "manual_auth",
      label: login.manualCheckpoint.checkpointLabel ?? "Manual login / OTP required",
      instructions:
        login.manualCheckpoint.instructions ??
        "Complete the private login or OTP step in the active browser session, then continue the checkpoint.",
      currentPageUrl: page.url(),
      expiresAt: new Date(Date.now() + timeoutSeconds * 1000).toISOString(),
      liveSession,
      loginUrl: page.url(),
      allowedActions: ["continue_after_login"],
    });
    }
    }
  }

  if (login.waitForSelector) {
    await page.waitForSelector(login.waitForSelector, {
      timeout: env.crawler.timeoutMs,
    });
  }

  if (login.waitForUrlIncludes) {
    await page.waitForURL(
      (url) => url.toString().includes(login.waitForUrlIncludes ?? ""),
      {
        timeout: env.crawler.timeoutMs,
      },
    );
  }
};

const evaluateInteraction = async ({
  page,
  pageUrl,
  pageKey,
  element,
  consoleEvents,
  networkRequests,
  runId,
}: {
  page: Page;
  pageUrl: string;
  pageKey: string;
  element: DetectedInteractiveElement;
  consoleEvents: string[];
  networkRequests: NetworkObservation[];
  runId: string;
}): Promise<{ result: InteractionResult; edge: NavigationEdge }> => {
  await restorePageState(page, pageUrl);
  await annotateAndExtractInteractiveElements(page, pageUrl, pageKey);

  const action = getInteractionAction(element);
  const beforeUrl = page.url();
  const beforeSignature = await getPageSignature(page);
  const beforeDomSnippet = await getDomSnippet(page);
  const beforeRequestCount = networkRequests.length;
  const beforeConsoleCount = consoleEvents.length;
  const beforeState = await captureElementState(page, element.id);
  const locator = page.locator(`[data-sk-interaction-id="${element.id}"]`).first();
  let dialogOpened = false;
  let popupOpened = false;
  let downloadTriggered = false;
  let keyboardTriggered = false;
  let hoverChanged = false;
  const dialogHandler = (dialog: { dismiss: () => Promise<void> }) => {
    dialogOpened = true;
    void dialog.dismiss().catch(() => undefined);
  };
  const popupHandler = (popupPage: Page) => {
    popupOpened = true;
    void popupPage.close().catch(() => undefined);
  };
  const downloadHandler = () => {
    downloadTriggered = true;
  };
  let screenshotPath: string | undefined;
  let screenshotUrl: string | undefined;
  let beforeScreenshotUrl: string | undefined;
  let afterScreenshotUrl: string | undefined;

  try {
    const folder = screenshotDirectory(runId);
    await mkdir(folder, { recursive: true });
    const beforeFileName = `${element.id}-before.png`;
    const beforePath = path.join(folder, beforeFileName);
    beforeScreenshotUrl = screenshotUrlFromPath(runId, beforeFileName);
    await locator.screenshot({ path: beforePath }).catch(async () => {
      await page.screenshot({ path: beforePath, fullPage: true });
    });
  } catch {
    beforeScreenshotUrl = undefined;
  }

  try {
    page.on("dialog", dialogHandler);
    page.on("popup", popupHandler);
    page.on("download", downloadHandler);

    await locator.scrollIntoViewIfNeeded();
    await locator.hover({ timeout: Math.min(env.crawler.timeoutMs, 2_000) }).catch(() => undefined);
    const afterHoverState = await captureElementState(page, element.id).catch(() => beforeState);
    hoverChanged = didElementStateChange(beforeState, afterHoverState);
    if (action === "check") {
      await locator.check({ timeout: env.crawler.timeoutMs });
    } else if (action === "fill") {
      await locator.fill("sk-crawlpulse probe value", { timeout: env.crawler.timeoutMs });
      const formOwner = await locator.evaluate((node) => Boolean((node as HTMLInputElement | HTMLTextAreaElement).form)).catch(() => false);
      if (formOwner) {
        await locator.press("Enter").then(() => {
          keyboardTriggered = true;
        }).catch(() => undefined);
      }
      await locator.blur().catch(() => undefined);
    } else if (action === "select") {
      const options = await locator.locator("option").count();
      if (options > 1) {
        await locator.selectOption({ index: 1 });
      } else {
        await locator.selectOption({ index: 0 }).catch(() => undefined);
      }
    } else {
      await locator.click({ timeout: env.crawler.timeoutMs });
    }
    await waitForPageSettled(page, Math.min(env.crawler.timeoutMs, env.crawler.navigationRecoverySettleTimeoutMs));

    const afterUrl = page.url();
    const afterSignature = await getPageSignature(page);
    const afterDomSnippet = await getDomSnippet(page);
    const afterState = await captureElementState(page, element.id);
    const domChanged = beforeSignature !== afterSignature;
    const apiCallTriggered = networkRequests.length > beforeRequestCount;
    const consoleTriggered = consoleEvents.length > beforeConsoleCount;
    const urlChanged = beforeUrl !== afterUrl;
    const elementStateChanged = didElementStateChange(beforeState, afterState);
    const behaviorSignals = {
      urlChanged,
      domChanged,
      apiCallTriggered,
      consoleTriggered,
      elementStateChanged,
      hoverChanged,
      keyboardTriggered,
      dialogOpened,
      popupOpened,
      downloadTriggered,
    };
    const passReasons = collectPassReasons(behaviorSignals);
    const resultStatus: "PASS" | "FAIL" =
      passReasons.length > 0 ? "PASS" : "FAIL";
    const issueSummary =
      resultStatus === "FAIL"
        ? `Triggered ${action} but no navigation, control-state, console, DOM, or network signal was observed.`
        : undefined;

    if (resultStatus === "FAIL") {
      const folder = screenshotDirectory(runId);
      const fileName = `${element.id}.png`;
      const afterFileName = `${element.id}-after.png`;
      await mkdir(folder, { recursive: true });
      screenshotPath = path.join(folder, fileName);
      screenshotUrl = screenshotUrlFromPath(runId, fileName);
      afterScreenshotUrl = screenshotUrlFromPath(runId, afterFileName);
      await locator.screenshot({ path: screenshotPath }).catch(async () => {
        await page.screenshot({
          path: screenshotPath,
          fullPage: true,
        });
      });
      await locator.screenshot({ path: path.join(folder, afterFileName) }).catch(async () => {
        await page.screenshot({
          path: path.join(folder, afterFileName),
          fullPage: true,
        });
      });
    }

    return {
      result: {
        buttonId: element.id,
        pageUrl,
        text: element.text || element.selector,
        action,
        selector: element.selector,
        beforeUrl,
        afterUrl,
        result: resultStatus,
        error: resultStatus === "FAIL" ? "No observable effect detected" : null,
          issueSummary,
          domChanged,
          apiCallTriggered,
          beforeScreenshotUrl,
          afterScreenshotUrl,
          beforeDomSnippet,
          afterDomSnippet,
          domDiffSummary: `Action ${action}; pass reasons: ${passReasons.join(", ") || "none"}; DOM ${domChanged ? "changed" : "did not change"}; network ${apiCallTriggered ? "changed" : "did not change"}; console ${consoleTriggered ? "changed" : "did not change"}; control state ${elementStateChanged ? "changed" : "did not change"}.`,
          passReasons,
          behaviorSignals,
          screenshotPath,
          screenshotUrl,
        },
      edge: {
        from: beforeUrl,
        to: afterUrl,
        action: element.text || element.selector,
        interactionId: element.id,
        result: resultStatus,
      },
    };
  } catch (error) {
    const folder = screenshotDirectory(runId);
    const fileName = `${element.id}.png`;
    const afterFileName = `${element.id}-after.png`;
    await mkdir(folder, { recursive: true });
    screenshotPath = path.join(folder, fileName);
    screenshotUrl = screenshotUrlFromPath(runId, fileName);
    afterScreenshotUrl = screenshotUrlFromPath(runId, afterFileName);
    await locator.screenshot({ path: screenshotPath }).catch(async () => {
      await page.screenshot({
        path: screenshotPath,
        fullPage: true,
      }).catch(() => undefined);
    });
    await locator.screenshot({ path: path.join(folder, afterFileName) }).catch(async () => {
      await page.screenshot({
        path: path.join(folder, afterFileName),
        fullPage: true,
      }).catch(() => undefined);
    });
    const afterDomSnippet = await getDomSnippet(page).catch(() => "");

    return {
      result: {
        buttonId: element.id,
        pageUrl,
        text: element.text || element.selector,
        action,
        selector: element.selector,
        beforeUrl,
        afterUrl: page.url(),
        result: "FAIL",
        error: error instanceof Error ? error.message : "Interaction failed",
        issueSummary: "Click failed before the page produced a visible result.",
        domChanged: false,
        apiCallTriggered: networkRequests.length > beforeRequestCount,
        beforeScreenshotUrl,
        afterScreenshotUrl,
        beforeDomSnippet,
        afterDomSnippet,
        domDiffSummary: `Before: ${beforeDomSnippet.length} chars. After failure: ${afterDomSnippet.length} chars.`,
        passReasons: [],
        behaviorSignals: {
          urlChanged: beforeUrl !== page.url(),
          domChanged: false,
          apiCallTriggered: networkRequests.length > beforeRequestCount,
          consoleTriggered: consoleEvents.length > beforeConsoleCount,
          elementStateChanged: false,
          hoverChanged,
          keyboardTriggered,
          dialogOpened,
          popupOpened,
          downloadTriggered,
        },
        screenshotPath,
        screenshotUrl,
      },
      edge: {
        from: beforeUrl,
        to: page.url(),
        action: element.text || element.selector,
        interactionId: element.id,
        result: "FAIL",
      },
    };
  } finally {
    page.off("dialog", dialogHandler);
    page.off("popup", popupHandler);
    page.off("download", downloadHandler);
    await restorePageState(page, pageUrl).catch(() => undefined);
  }
};

export const crawlFrontend = async (
  request: AnalysisRequest,
  runId: string,
  callbacks?: CrawlCallbacks,
): Promise<FrontendAnalysis> => {
  const baseUrl = normalizeUrl(request.targetUrl);
  const profile = resolveCrawlProfile(request, baseUrl);
  const maxPages = profile.maxPages;
  const maxLinksPerPage = profile.maxLinksPerPage;
  const maxDepth = profile.maxDepth;
  const maxInteractionsPerPage = profile.maxInteractionsPerPage;
  const domainAllowlist = request.options?.domainAllowlist ?? [baseUrl.hostname];
  const excludePathPatterns = profile.excludePathPatterns;
  const resumeFrom = request.options?.resumeFrom;
  const launchHeadless = request.auth?.login?.manualCheckpoint?.enabled
    ? false
    : request.auth?.login?.headed === true
      ? false
      : env.crawler.headless;

  const browser = await launchBrowser(launchHeadless);

  const contextOptions: BrowserContextOptions = {
    ignoreHTTPSErrors: true,
    extraHTTPHeaders: request.auth?.headers,
  };

  if (request.auth?.storageStatePath) {
    contextOptions.storageState = request.auth.storageStatePath;
  }

  const context = await browser.newContext(contextOptions);
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", {
      get: () => undefined,
    });

    Object.defineProperty(navigator, "languages", {
      get: () => ["en-US", "en"],
    });

    Object.defineProperty(navigator, "plugins", {
      get: () => [1, 2, 3, 4, 5],
    });

    const chromeRuntime = {
      runtime: {},
      app: {},
    };

    Object.defineProperty(window, "chrome", {
      get: () => chromeRuntime,
    });
  });
  const page = await context.newPage();
  const networkRequests: NetworkObservation[] = [];
  const warnings: string[] = [];
  const consoleEvents: string[] = [];
  const runtimeFindings: RuntimeFinding[] = [];
  const loginPromptState = { handled: false };
  attachNetworkTracking(context, networkRequests, baseUrl);

  page.on("console", (message) => {
    const line = `[${message.type()}] ${message.text()}`.slice(0, 240);
    consoleEvents.push(line);
    if (message.type() === "error") {
      runtimeFindings.push({
        findingId: `console_${Date.now()}_${runtimeFindings.length + 1}`,
        type: "console_error",
        severity: "medium",
        pageUrl: page.url() || baseUrl.toString(),
        summary: "Console error captured",
        details: line,
        evidence: [line],
      });
    }
  });
  page.on("pageerror", (error) => {
    const line = `[pageerror] ${error.message}`.slice(0, 240);
    consoleEvents.push(line);
    runtimeFindings.push({
      findingId: `pageerror_${Date.now()}_${runtimeFindings.length + 1}`,
      type: "js_exception",
      severity: "high",
      pageUrl: page.url() || baseUrl.toString(),
      summary: "Unhandled JavaScript exception captured",
      details: line,
      evidence: [line],
    });
  });

  try {
    await callbacks?.onProgress?.({
      stageKey: "preparing-session",
      stageLabel: "Preparing session",
      summary: `Opening browser session (${profile.name} profile)`,
      technical: `Starting browser context and applying crawl controls for the ${profile.name} profile.`,
      currentPageUrl: baseUrl.toString(),
      expectedDurationSeconds: Math.max(45, maxPages * 8),
      pagesDiscovered: 0,
      interactionsDetected: 0,
      interactionsTested: 0,
      pagesPreview: [],
    });

    await prepareAuth({
      page,
      context,
      request,
      runId,
      networkRequests,
      consoleEvents,
      callbacks,
    });

    await maybePauseForDetectedLogin({
      page,
      request,
      runId,
      networkRequests,
      consoleEvents,
      callbacks,
      promptState: loginPromptState,
    });

    await callbacks?.onProgress?.({
      stageKey: "discovering-pages",
      stageLabel: "Discovering pages",
      summary: `Finding connected pages (${profile.name} profile)`,
      technical: `Following same-origin and allowed-domain links with depth and robots controls for the ${profile.name} profile.`,
      currentPageUrl: baseUrl.toString(),
      expectedDurationSeconds: Math.max(45, maxPages * 8),
      pagesDiscovered: 0,
      interactionsDetected: 0,
      interactionsTested: 0,
      pagesPreview: [],
    });

    const discoveredPages = await discoverConnectedPages({
      page,
      baseUrl,
      maxPages,
      maxDepth,
      maxLinksPerPage,
      runId,
      domainAllowlist,
      excludePathPatterns,
      respectRobotsTxt: request.options?.respectRobotsTxt ?? true,
      networkRequests,
      consoleEvents,
      maybeHandleLoginSurface: async () => {
        await maybePauseForDetectedLogin({
          page,
          request,
          runId,
          networkRequests,
          consoleEvents,
          callbacks,
          promptState: loginPromptState,
        });
      },
      onWarning: async (message) => {
        warnings.push(message);
        await callbacks?.onWarning?.(message);
      },
      onDiscoveredPage: async (pages, latest) => {
        const detectedInteractions = pages.reduce((sum, entry) => sum + entry.interactiveElements.length, 0);
        const persistedPage = toPageAnalysis(latest);
        await callbacks?.onPage?.(persistedPage);
        await callbacks?.onProgress?.({
          stageKey: "discovering-pages",
          stageLabel: "Discovering pages",
          summary: `Found ${pages.length} page(s)`,
          technical: `Latest page: ${latest.snapshot.title}. Recursive discovery is still running.`,
          currentPageUrl: latest.url,
          expectedDurationSeconds: Math.max(45, maxPages * 8),
          pagesDiscovered: pages.length,
          interactionsDetected: detectedInteractions,
          interactionsTested: 0,
          pagesPreview: pages.slice(-4).map((entry) => ({
            url: entry.url,
            title: entry.snapshot.title,
            routePath: entry.routeKey,
            interactiveCount: entry.interactiveElements.length,
            headings: entry.snapshot.headings.slice(0, 3),
            buttons: entry.snapshot.buttons.slice(0, 4).map((item) => item.text || item.selector),
            links: entry.snapshot.links.slice(0, 4).map((item) => item.text || item.selector),
            previewImageUrl: entry.previewImageUrl,
            htmlPreview: entry.htmlPreview,
          })),
          liveSession: buildLiveSession({
            url: latest.url,
            title: latest.snapshot.title,
            html: latest.htmlPreview,
            previewImageUrl: latest.previewImageUrl,
            consoleEvents,
            networkRequests,
          }),
        });
      },
    });

    const visited = new Set<string>();
    const interactionResults: InteractionResult[] = [];
    const navigationGraph: NavigationEdge[] = [];
    const interactiveElements = discoveredPages.flatMap((entry) =>
      entry.interactiveElements.slice(0, maxInteractionsPerPage),
    );
    const completedInteractionIds = new Set(resumeFrom?.completedInteractionIds ?? []);
    const completedPageUrls = new Set(resumeFrom?.completedPageUrls ?? []);

    for (const entry of discoveredPages) {
      if (resumeFrom?.pageUrl && completedPageUrls.has(entry.url) && entry.url !== resumeFrom.pageUrl) {
        continue;
      }

      await gotoStable(page, entry.url, env.crawler.timeoutMs);
      await maybePauseForDetectedLogin({
        page,
        request,
        runId,
        networkRequests,
        consoleEvents,
        callbacks,
        promptState: loginPromptState,
      });
      runtimeFindings.push(...(await analyzeAccessibility(page, entry.url)));
      runtimeFindings.push(
        ...(await analyzeVisualRegression(page, entry.url, entry.baselineSignature ?? "")),
      );

      await callbacks?.onProgress?.({
        stageKey: "testing-interactions",
        stageLabel: "Testing interactions",
        summary: `Testing ${entry.snapshot.title}`,
        technical: "Executing visible controls with per-page limits and incremental persistence.",
        currentPageUrl: entry.url,
        expectedDurationSeconds: Math.max(45, maxPages * 8),
        pagesDiscovered: discoveredPages.length,
        interactionsDetected: interactiveElements.length,
        interactionsTested: interactionResults.length,
        pagesPreview: [
          {
            url: entry.url,
            title: entry.snapshot.title,
            routePath: entry.routeKey,
            interactiveCount: entry.interactiveElements.length,
            headings: entry.snapshot.headings.slice(0, 3),
            buttons: entry.snapshot.buttons.slice(0, 4).map((item) => item.text || item.selector),
            links: entry.snapshot.links.slice(0, 4).map((item) => item.text || item.selector),
            previewImageUrl: entry.previewImageUrl,
            htmlPreview: entry.htmlPreview,
          },
        ],
        liveSession: buildLiveSession({
          url: entry.url,
          title: entry.snapshot.title,
          html: entry.htmlPreview,
          previewImageUrl: entry.previewImageUrl,
          consoleEvents,
          networkRequests,
        }),
      });

        for (const element of entry.interactiveElements.slice(0, maxInteractionsPerPage)) {
        if (visited.has(element.id) || completedInteractionIds.has(element.id)) {
          continue;
        }

        visited.add(element.id);

        const { result, edge } = await evaluateInteraction({
          page,
          pageUrl: entry.url,
          pageKey: entry.key,
          element,
          consoleEvents,
          networkRequests,
          runId,
        });

        interactionResults.push(result);
        navigationGraph.push(edge);
        await callbacks?.onInteraction?.(result);

        const failureClusters = buildFailureClusters(interactionResults);
        await callbacks?.onFailureClusters?.(failureClusters);

        await callbacks?.onProgress?.({
          stageKey: "testing-interactions",
          stageLabel: "Testing interactions",
          summary: `${interactionResults.length} of ${interactiveElements.length} tested`,
          technical: `Latest action: ${element.text || element.selector} on ${entry.snapshot.title}.`,
          currentPageUrl: entry.url,
          currentInteractionId: element.id,
          expectedDurationSeconds: Math.max(45, maxPages * 8),
          pagesDiscovered: discoveredPages.length,
          interactionsDetected: interactiveElements.length,
          interactionsTested: interactionResults.length,
          completedPages: interactionResults.length > 0 ? new Set(interactionResults.map((item) => item.pageUrl)).size : 0,
          lastSuccessfulAction:
            result.result === "PASS"
              ? {
                  label: result.text,
                  pageUrl: result.pageUrl,
                  interactionId: result.buttonId,
                  at: new Date().toISOString(),
                }
              : undefined,
          pagesPreview: [
            {
              url: entry.url,
              title: entry.snapshot.title,
              routePath: entry.routeKey,
              interactiveCount: entry.interactiveElements.length,
              headings: entry.snapshot.headings.slice(0, 3),
              buttons: entry.snapshot.buttons.slice(0, 4).map((item) => item.text || item.selector),
              links: entry.snapshot.links.slice(0, 4).map((item) => item.text || item.selector),
              previewImageUrl: entry.previewImageUrl,
              htmlPreview: entry.htmlPreview,
            },
          ],
          liveSession: buildLiveSession({
            url: entry.url,
            title: entry.snapshot.title,
            html: request.options?.streamHtmlPreview === false ? undefined : await normalizeHtmlPreview(page, page.url()).catch(() => undefined),
            previewImageUrl: await capturePreviewImage({
              page,
              runId,
              fileName: `${entry.key}-live.png`,
            }),
            consoleEvents,
            networkRequests,
          }),
        });
      }
    }

    if (interactiveElements.length !== interactionResults.length) {
      warnings.push(
        `Coverage mismatch detected. Found ${interactiveElements.length} interactive elements but tested ${interactionResults.length}.`,
      );
    }

    warnings.unshift(
      `Crawl profile: ${profile.name}; maxPages=${maxPages}; maxDepth=${maxDepth}; maxInteractionsPerPage=${maxInteractionsPerPage}.`,
    );

    const scenarioPass = await executeScenarioPacks({
      page,
      pages: discoveredPages.map((entry) => toPageAnalysis(entry)),
      runId,
    });
    const boundaryPass = await runBoundaryAndLimitChecks({
      page,
      pages: discoveredPages.map((entry) => toPageAnalysis(entry)),
      runId,
    });

    runtimeFindings.push(...scenarioPass.runtimeFindings, ...boundaryPass.runtimeFindings);

    networkRequests
      .filter((request) => request.failed || (typeof request.status === "number" && request.status >= 400))
      .forEach((request, index) => {
        runtimeFindings.push({
          findingId: `request_${Date.now()}_${index + 1}`,
          type: "request_failure",
          severity: request.status && request.status >= 500 ? "high" : "medium",
          pageUrl: request.pageUrl ?? baseUrl.toString(),
          summary: "Network request failed or returned an error status",
          details: `${request.method} ${request.url} ${request.status ?? request.failureText ?? ""}`.trim(),
          evidence: [
            request.resourceType,
            request.failureText ?? `status:${request.status ?? "unknown"}`,
            request.latencyMs ? `latency:${request.latencyMs}` : "latency:unknown",
          ],
        });
      });

    const apiAssertions: ApiAssertion[] = await buildApiAssertions(networkRequests);
    apiAssertions
      .filter((assertion) => !assertion.passed)
      .forEach((assertion, index) => {
        runtimeFindings.push({
          findingId: `api_${Date.now()}_${index + 1}`,
          type: "api_contract",
          severity: assertion.status && assertion.status >= 500 ? "high" : "medium",
          pageUrl: assertion.pageUrl ?? baseUrl.toString(),
          summary: "API assertion failed",
          details: `${assertion.method} ${assertion.url}`,
          evidence: assertion.issues,
        });
      });

    const failureClusters = buildFailureClusters(interactionResults);
    await callbacks?.onFailureClusters?.(failureClusters);
    const coverageReport = buildCoverageReport(interactionResults, interactiveElements.length);

    return {
      baseUrl: baseUrl.toString(),
      pages: discoveredPages.map((entry) => ({
        ...toPageAnalysis(entry),
        interactionNotes: [
          ...entry.snapshot.interactionNotes,
          `Tested ${Math.min(entry.interactiveElements.length, maxInteractionsPerPage)} interactions on this page`,
        ],
      })),
      interactiveElements,
      interactionResults,
      navigationGraph,
      networkRequests: networkRequests.slice(0, 500),
      coverageReport,
      failureClusters,
      runtimeFindings: uniqueFindings(runtimeFindings),
      scenarioResults: [...scenarioPass.scenarioResults, ...boundaryPass.scenarioResults],
      apiAssertions,
      warnings,
    };
  } catch (error) {
    if (isClosedTargetError(error)) {
      throw new HttpError(502, "Frontend interaction crawl failed", {
        message:
          "Crawler browser session closed unexpectedly before the run finished. If a visible Playwright window was open, do not close it during the run.",
      });
    }
    throw new HttpError(502, "Frontend interaction crawl failed", {
      message: formatCrawlerError(error),
    });
  } finally {
    await context.close();
    await browser.close();
  }
};
