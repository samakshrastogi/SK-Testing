import { mkdir, writeFile } from "fs/promises";
import path from "path";
import type { Page, Response as PlaywrightResponse } from "playwright";
import { env } from "../../config/env";
import type {
  ApiAssertion,
  NetworkObservation,
  PageAnalysis,
  RuntimeFinding,
  ScenarioPackResult,
} from "../../types/platform";

const isTimeoutError = (error: unknown) =>
  error instanceof Error &&
  (error.name === "TimeoutError" || /Timeout \d+ms exceeded/i.test(error.message));

const buildArtifactPublicUrl = (...segments: string[]) =>
  `${env.runtime.artifactsPublicRoute}/${segments.map((segment) => segment.replace(/^\/+|\/+$/g, "")).join("/")}`;

const waitForPageSettled = async (page: Page, timeoutMs = env.crawler.timeoutMs) => {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs }).catch(() => undefined);
  await page.waitForLoadState("load", { timeout: Math.min(timeoutMs, env.crawler.loadStateTimeoutMs) }).catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: Math.min(timeoutMs, env.crawler.networkIdleTimeoutMs) }).catch(() => undefined);
  await page.waitForTimeout(env.crawler.settleDelayMs).catch(() => undefined);
};

const gotoScenarioPage = async (page: Page, url: string, timeoutMs = env.crawler.timeoutMs) => {
  try {
    await page.goto(url, {
      waitUntil: "commit",
      timeout: timeoutMs,
    });
  } catch (error) {
    if (!isTimeoutError(error)) {
      throw error;
    }

    const currentUrl = page.url();
    const hasUsefulNavigation =
      currentUrl !== "about:blank" &&
      (currentUrl === url ||
        currentUrl.startsWith(`${url}/`) ||
        currentUrl.startsWith(`${url}?`) ||
        currentUrl.startsWith(`${url}#`));

    const hasDocument = await page
      .evaluate(() => document.readyState !== "loading" || Boolean(document.body?.innerHTML?.trim()))
      .catch(() => false);

    if (!hasUsefulNavigation && !hasDocument) {
      throw error;
    }
  }

  await waitForPageSettled(page, timeoutMs);
};

const scenarioDir = (runId: string) =>
  path.resolve(process.cwd(), env.runtime.artifactsDir, "scenario-failures", runId);

const scenarioUrl = (runId: string, fileName: string) => buildArtifactPublicUrl("scenario-failures", runId, fileName);

const summarizeShape = (value: unknown, depth = 0): string[] => {
  if (depth > 2) {
    return [];
  }

  if (Array.isArray(value)) {
    return [`array(${typeof value[0]})`, ...summarizeShape(value[0], depth + 1)];
  }

  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .slice(0, 12)
      .sort();
  }

  return [typeof value];
};

export const analyzeAccessibility = async (page: Page, pageUrl: string): Promise<RuntimeFinding[]> =>
  page.evaluate(
    ({ currentUrl }) => {
      const findings: Array<{
        type: "accessibility";
        severity: "low" | "medium" | "high";
        pageUrl: string;
        summary: string;
        details: string;
        evidence: string[];
      }> = [];

      const selectorOf = (element: Element) => {
        const htmlElement = element as HTMLElement;
        if (htmlElement.id) {
          return `#${htmlElement.id}`;
        }

        const name = htmlElement.getAttribute("name");
        if (name) {
          return `${element.tagName.toLowerCase()}[name="${name}"]`;
        }

        return element.tagName.toLowerCase();
      };

      const accessibleName = (element: Element) =>
        (
          element.getAttribute("aria-label") ??
          element.getAttribute("title") ??
          element.textContent ??
          (element as HTMLInputElement).value ??
          ""
        )
          .replace(/\s+/g, " ")
          .trim();

      document.querySelectorAll("button, a[href], input, select, textarea, [role='button']").forEach((element) => {
        const tag = element.tagName.toLowerCase();
        const input = element as HTMLInputElement;
        const name = accessibleName(element);
        const role = element.getAttribute("role");
        const type = input.type;

        if ((tag === "button" || tag === "a" || role === "button" || type === "button" || type === "submit") && !name) {
          findings.push({
            type: "accessibility",
            severity: "high",
            pageUrl: currentUrl,
            summary: "Interactive element is missing an accessible name",
            details: `${selectorOf(element)} is clickable but has no accessible label.`,
            evidence: [selectorOf(element)],
          });
        }

        if (["text", "email", "search", "password", "number", "tel", "url"].includes(type || tag)) {
          const labelled =
            Boolean(element.getAttribute("aria-label")) ||
            Boolean(element.getAttribute("aria-labelledby")) ||
            Boolean(document.querySelector(`label[for="${input.id}"]`)) ||
            element.closest("label") !== null;

          if (!labelled) {
            findings.push({
              type: "accessibility",
              severity: "medium",
              pageUrl: currentUrl,
              summary: "Form field is missing a label",
              details: `${selectorOf(element)} should be associated with a label or aria-label.`,
              evidence: [selectorOf(element)],
            });
          }
        }
      });

      document.querySelectorAll("[aria-hidden='true']").forEach((element) => {
        if (element.querySelector("a, button, input, select, textarea, [tabindex]")) {
          findings.push({
            type: "accessibility",
            severity: "high",
            pageUrl: currentUrl,
            summary: "Focusable content is inside aria-hidden container",
            details: `${selectorOf(element)} hides focusable content from assistive technology.`,
            evidence: [selectorOf(element)],
          });
        }
      });

      document.querySelectorAll("[tabindex]").forEach((element) => {
        const tabIndex = Number(element.getAttribute("tabindex"));
        if (tabIndex > 0) {
          findings.push({
            type: "accessibility",
            severity: "medium",
            pageUrl: currentUrl,
            summary: "Positive tabindex detected",
            details: `${selectorOf(element)} uses tabindex=${tabIndex}, which can break focus order.`,
            evidence: [selectorOf(element)],
          });
        }
      });

      const rgb = (input: string): [number, number, number] | null => {
        const match = input.match(/\d+/g);
        if (!match || match.length < 3) {
          return null;
        }

        return [Number(match[0]), Number(match[1]), Number(match[2])];
      };

      Array.from(document.querySelectorAll("body *"))
        .slice(0, 120)
        .forEach((element) => {
          const htmlElement = element as HTMLElement;
          const text = (htmlElement.innerText ?? "").trim();
          if (!text || text.length > 120) {
            return;
          }

          const style = window.getComputedStyle(htmlElement);
          const fg = rgb(style.color);
          const bg = rgb(style.backgroundColor || window.getComputedStyle(document.body).backgroundColor);
          if (!fg || !bg) {
            return;
          }

          const ratio = (() => {
            const lum = ([r, g, b]: [number, number, number]) => {
              const values = [r, g, b].map((value) => {
                const normalized = value / 255;
                return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
              });
              return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722;
            };
            const l1 = lum(fg);
            const l2 = lum(bg);
            const lighter = Math.max(l1, l2);
            const darker = Math.min(l1, l2);
            return (lighter + 0.05) / (darker + 0.05);
          })();

          if (ratio < 4.5) {
            findings.push({
              type: "accessibility",
              severity: "low",
              pageUrl: currentUrl,
              summary: "Potential low contrast text",
              details: `${selectorOf(htmlElement)} may fail minimum contrast with ratio ${ratio.toFixed(2)}.`,
              evidence: [text.slice(0, 60)],
            });
          }
        });

      return findings;
    },
    { currentUrl: pageUrl },
  ).then((items) =>
    items.map((item, index) => ({
      findingId: `a11y_${index + 1}_${Date.now()}`,
      ...item,
    })),
  );

export const analyzeVisualRegression = async (
  page: Page,
  pageUrl: string,
  baselineSignature: string,
): Promise<RuntimeFinding[]> => {
  const metrics = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth,
    overflowNodes: Array.from(document.querySelectorAll("body *"))
      .filter((node) => {
        const element = node as HTMLElement;
        const rect = element.getBoundingClientRect();
        return rect.right > window.innerWidth + 12;
      })
      .slice(0, 8)
      .map((node) => (node as HTMLElement).tagName.toLowerCase()),
  }));

  const findings: RuntimeFinding[] = [];
  if (metrics.scrollWidth > metrics.viewportWidth + 8) {
    findings.push({
      findingId: `visual_overflow_${Date.now()}`,
      type: "visual_regression",
      severity: "medium",
      pageUrl,
      summary: "Horizontal overflow detected",
      details: `Page width exceeds viewport by ${metrics.scrollWidth - metrics.viewportWidth}px.`,
      evidence: metrics.overflowNodes.length > 0 ? metrics.overflowNodes : ["documentElement"],
    });
  }

  const currentSignature = await page.evaluate(() =>
    JSON.stringify({
      textLength: (document.body?.innerText ?? "").length,
      nodeCount: document.querySelectorAll("*").length,
    }),
  );

  if (baselineSignature !== currentSignature) {
    findings.push({
      findingId: `visual_state_${Date.now()}`,
      type: "visual_regression",
      severity: "low",
      pageUrl,
      summary: "Visual state changed between baseline and current state",
      details: "DOM size or visible text volume changed after the interaction.",
      evidence: [baselineSignature, currentSignature],
    });
  }

  return findings;
};

export const buildApiAssertions = async (requests: NetworkObservation[]): Promise<ApiAssertion[]> =>
  requests
    .filter((request) => /fetch|xhr|document/.test(request.resourceType))
    .slice(0, 120)
    .map((request, index) => {
      const issues: string[] = [];

      if (request.failed) {
        issues.push(request.failureText ?? "Request failed");
      }

      if (typeof request.status === "number" && request.status >= 400) {
        issues.push(`Unexpected HTTP status ${request.status}`);
      }

      if (typeof request.latencyMs === "number" && request.latencyMs > 2500) {
        issues.push(`Latency ${request.latencyMs}ms exceeded 2500ms`);
      }

      if (
        request.contentType?.includes("application/json") &&
        (!request.responseShape || request.responseShape.length === 0)
      ) {
        issues.push("JSON response shape could not be inferred");
      }

      return {
        assertionId: `api_${index + 1}`,
        url: request.url,
        method: request.method,
        pageUrl: request.pageUrl,
        status: request.status,
        latencyMs: request.latencyMs,
        passed: issues.length === 0,
        issues,
        responseShape: request.responseShape,
      };
    });

const captureScenarioScreenshot = async (page: Page, runId: string, fileName: string) => {
  const folder = scenarioDir(runId);
  await mkdir(folder, { recursive: true });
  const outputPath = path.join(folder, fileName);
  await page.screenshot({ path: outputPath, fullPage: true });
  return scenarioUrl(runId, fileName);
};

const setTempUploadFile = async () => {
  const tempDir = path.resolve(process.cwd(), env.runtime.artifactsDir, "tmp");
  await mkdir(tempDir, { recursive: true });
  const smallPath = path.join(tempDir, "sample-upload.txt");
  const largePath = path.join(tempDir, "sample-upload-large.txt");
  await writeFile(smallPath, "sample file upload");
  await writeFile(largePath, "x".repeat(1024 * 256));
  return { smallPath, largePath };
};

export const executeScenarioPacks = async ({
  page,
  pages,
  runId,
}: {
  page: Page;
  pages: PageAnalysis[];
  runId: string;
}): Promise<{ scenarioResults: ScenarioPackResult[]; runtimeFindings: RuntimeFinding[] }> => {
  const scenarioResults: ScenarioPackResult[] = [];
  const runtimeFindings: RuntimeFinding[] = [];

  for (const currentPage of pages) {
    await gotoScenarioPage(page, currentPage.url, env.crawler.timeoutMs);

    const indicators = {
      auth: currentPage.inputs.some((input) => input.type === "password"),
      search: currentPage.inputs.some(
        (input) =>
          input.type === "search" ||
          /search/i.test(input.selector) ||
          /search/i.test(input.text),
      ),
      cart: currentPage.buttons.some((button) => /cart|checkout|buy/i.test(button.text)),
      forms: currentPage.forms.length > 0,
      pagination: currentPage.links.some((link) => /next|prev|page/i.test(link.text)),
      tables: await page.locator("table").count().then((count) => count > 0),
      filters: await page
        .locator("select, input[type='checkbox'], input[type='radio']")
        .count()
        .then((count) => count > 0),
      uploads: currentPage.inputs.some((input) => input.type === "file"),
    };

    if (indicators.auth) {
      scenarioResults.push({
        scenarioId: `auth_${scenarioResults.length + 1}`,
        pack: "auth",
        pageUrl: currentPage.url,
        pageTitle: currentPage.title,
        status: "INFO",
        summary: "Authentication flow detected",
        details: ["Password field found on page."],
        suggestions: ["Add session-aware tests for valid login, invalid login, and expired session flows."],
      });
    }

    if (indicators.search) {
      const searchLocator = page.locator("input[type='search'], input[placeholder*='search' i]").first();
      if ((await searchLocator.count()) > 0) {
        await searchLocator.fill("qa smoke query").catch(() => undefined);
        await searchLocator.press("Enter").catch(() => undefined);
        await page.waitForTimeout(env.crawler.settleDelayMs);
        scenarioResults.push({
          scenarioId: `search_${scenarioResults.length + 1}`,
          pack: "search",
          pageUrl: currentPage.url,
          pageTitle: currentPage.title,
          status: "INFO",
          summary: "Search scenario executed",
          details: ["Filled detected search input and submitted with Enter."],
          suggestions: ["Verify empty query, long query, and no-results states."],
        });
      }
    }

    if (indicators.forms) {
      const formLocator = page.locator("form").first();
      const submitLocator = formLocator.locator("button[type='submit'], input[type='submit']").first();
      if ((await formLocator.count()) > 0 && (await submitLocator.count()) > 0) {
        const validationBefore = await page.locator(":invalid").count();
        await submitLocator.click().catch(() => undefined);
        await page.waitForTimeout(env.crawler.recoveryWaitMs);
        const validationAfter = await page.locator(":invalid").count();
        scenarioResults.push({
          scenarioId: `forms_${scenarioResults.length + 1}`,
          pack: "forms",
          pageUrl: currentPage.url,
          pageTitle: currentPage.title,
          status: validationAfter >= validationBefore ? "PASS" : "FAIL",
          summary: "Form validation scenario executed",
          details: [`Invalid fields before submit: ${validationBefore}`, `Invalid fields after submit: ${validationAfter}`],
          suggestions: ["Ensure required fields block submission with explicit messages."],
        });
      }
    }

    if (indicators.pagination) {
      const paginationTarget = page
        .locator("a, button")
        .filter({ hasText: /next|more|older/i })
        .first();
      if ((await paginationTarget.count()) > 0) {
        const before = page.url();
        await paginationTarget.click().catch(() => undefined);
        await waitForPageSettled(page, Math.min(env.crawler.timeoutMs, env.crawler.navigationRecoverySettleTimeoutMs));
        scenarioResults.push({
          scenarioId: `pagination_${scenarioResults.length + 1}`,
          pack: "pagination",
          pageUrl: currentPage.url,
          pageTitle: currentPage.title,
          status: before !== page.url() ? "PASS" : "INFO",
          summary: "Pagination scenario executed",
          details: [`Before URL: ${before}`, `After URL: ${page.url()}`],
          suggestions: ["Test very large page numbers and last-page boundaries."],
        });
      }
    }

    if (indicators.filters) {
      const filterControl = page.locator("select, input[type='checkbox'], input[type='radio']").first();
      if ((await filterControl.count()) > 0) {
        await filterControl.click().catch(() => undefined);
        await page.waitForTimeout(400);
        scenarioResults.push({
          scenarioId: `filters_${scenarioResults.length + 1}`,
          pack: "filters",
          pageUrl: currentPage.url,
          pageTitle: currentPage.title,
          status: "INFO",
          summary: "Filter control toggled",
          details: ["Detected filter-like control and toggled one instance."],
          suggestions: ["Check combined filters, reset state, and empty-result behavior."],
        });
      }
    }

    if (indicators.tables) {
      const rowCount = await page.locator("table tbody tr").count().catch(() => 0);
      scenarioResults.push({
        scenarioId: `tables_${scenarioResults.length + 1}`,
        pack: "tables",
        pageUrl: currentPage.url,
        pageTitle: currentPage.title,
        status: rowCount > 0 ? "INFO" : "FAIL",
        summary: "Table scenario detected",
        details: [`Visible table rows: ${rowCount}`],
        suggestions: ["Test sorting, empty state, overflow columns, and large row counts."],
      });
    }

    if (indicators.uploads) {
      const uploadInput = page.locator("input[type='file']").first();
      const { smallPath, largePath } = await setTempUploadFile();
      await uploadInput.setInputFiles(smallPath).catch(() => undefined);
      await uploadInput.setInputFiles(largePath).catch(() => undefined);
      scenarioResults.push({
        scenarioId: `uploads_${scenarioResults.length + 1}`,
        pack: "uploads",
        pageUrl: currentPage.url,
        pageTitle: currentPage.title,
        status: "INFO",
        summary: "Upload scenario exercised",
        details: ["Tried small and larger local files against detected upload control."],
        suggestions: ["Verify allowed file types, file size rejection, and duplicate upload handling."],
      });
    }

    if (indicators.cart) {
      const cartButton = page.locator("button, a").filter({ hasText: /cart|checkout|buy/i }).first();
      if ((await cartButton.count()) > 0) {
        await cartButton.click().catch(() => undefined);
        await page.waitForTimeout(env.crawler.recoveryWaitMs);
        scenarioResults.push({
          scenarioId: `cart_${scenarioResults.length + 1}`,
          pack: "cart",
          pageUrl: currentPage.url,
          pageTitle: currentPage.title,
          status: "INFO",
          summary: "Cart scenario executed",
          details: ["Detected cart-oriented control and triggered one action."],
          suggestions: ["Check duplicate add-to-cart, inventory limits, and checkout recovery flows."],
        });
      }
    }
  }

  return { scenarioResults, runtimeFindings };
};

export const runBoundaryAndLimitChecks = async ({
  page,
  pages,
  runId,
}: {
  page: Page;
  pages: PageAnalysis[];
  runId: string;
}): Promise<{ scenarioResults: ScenarioPackResult[]; runtimeFindings: RuntimeFinding[] }> => {
  const scenarioResults: ScenarioPackResult[] = [];
  const runtimeFindings: RuntimeFinding[] = [];

  for (const currentPage of pages) {
    await gotoScenarioPage(page, currentPage.url, env.crawler.timeoutMs);

    const inputLocator = page.locator("input[type='text'], input[type='search'], input[type='email'], textarea").first();
    if ((await inputLocator.count()) > 0) {
      const overLimit = "x".repeat(1024);
      await inputLocator.fill(overLimit).catch(() => undefined);
      const valueLength = await inputLocator.inputValue().then((value) => value.length).catch(() => 0);

      scenarioResults.push({
        scenarioId: `boundary_text_${scenarioResults.length + 1}`,
        pack: "forms",
        pageUrl: currentPage.url,
        pageTitle: currentPage.title,
        status: "INFO",
        summary: "Input length boundary tested",
        details: [`Attempted 1024 characters; field accepted ${valueLength} characters.`],
        suggestions: ["Define explicit max lengths and user-visible counters for long text input."],
      });

      if (valueLength >= 1024) {
        runtimeFindings.push({
          findingId: `boundary_text_${Date.now()}`,
          type: "boundary_limit",
          severity: "medium",
          pageUrl: currentPage.url,
          summary: "Text input accepted a very large value without visible limit",
          details: "A detected text field accepted at least 1024 characters during the boundary probe.",
          evidence: [String(valueLength)],
        });
      }
    }

    const repeatedButton = page.locator("button, [role='button']").first();
    if ((await repeatedButton.count()) > 0) {
      const beforeUrl = page.url();
      for (let index = 0; index < 3; index += 1) {
        await repeatedButton.click().catch(() => undefined);
      }
      await page.waitForTimeout(env.crawler.recoveryWaitMs);
      scenarioResults.push({
        scenarioId: `rapid_click_${scenarioResults.length + 1}`,
        pack: "forms",
        pageUrl: currentPage.url,
        pageTitle: currentPage.title,
        status: "INFO",
        summary: "Rapid click probe executed",
        details: [`Clicked the same control three times rapidly. Final URL: ${page.url()}`],
        suggestions: ["Guard submit and destructive actions against duplicate rapid clicks."],
      });

      if (beforeUrl === page.url()) {
        runtimeFindings.push({
          findingId: `rapid_click_${Date.now()}`,
          type: "boundary_limit",
          severity: "low",
          pageUrl: currentPage.url,
          summary: "Rapid click probe produced no visible state protection signal",
          details: "The first clickable control was pressed rapidly three times; verify debouncing or request locking.",
          evidence: [repeatedButton.toString()],
        });
      }
    }

    const pageLinks = page.locator("a, button").filter({ hasText: /\d+/ }).first();
    if ((await pageLinks.count()) > 0) {
      scenarioResults.push({
        scenarioId: `pagination_limit_${scenarioResults.length + 1}`,
        pack: "pagination",
        pageUrl: currentPage.url,
        pageTitle: currentPage.title,
        status: "INFO",
        summary: "Pagination size target detected",
        details: ["Numeric pagination-like control detected; manual large-page and out-of-range checks recommended."],
        suggestions: ["Probe last page, page 0, and very large page values for safe handling."],
      });
    }

    const visualShot = await captureScenarioScreenshot(page, runId, `boundary-${scenarioResults.length + 1}.png`).catch(() => undefined);
    if (visualShot) {
      runtimeFindings.push({
        findingId: `visual_baseline_${Date.now()}`,
        type: "visual_regression",
        severity: "low",
        pageUrl: currentPage.url,
        summary: "Boundary test state snapshot captured",
        details: "A baseline screenshot was captured during limit probing for later comparison.",
        evidence: [visualShot],
        screenshotUrl: visualShot,
      });
    }
  }

  return { scenarioResults, runtimeFindings };
};

export const inferResponseShape = async (response: PlaywrightResponse) => {
  const contentType = response.headers()["content-type"] ?? undefined;
  if (!contentType?.includes("application/json")) {
    return { contentType, responseShape: undefined as string[] | undefined };
  }

  try {
    const json = await response.json();
    return {
      contentType,
      responseShape: summarizeShape(json),
    };
  } catch {
    return {
      contentType,
      responseShape: undefined,
    };
  }
};
