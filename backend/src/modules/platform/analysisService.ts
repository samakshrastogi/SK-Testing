import { randomUUID } from "crypto";
import type { Response } from "express";
import { crawlFrontend } from "../frontend/crawler";
import { generateTestCases } from "../frontend/testGenerator";
import { validateBackendInput } from "../backend/apiValidator";
import { buildReport } from "../reporting/reportBuilder";
import {
  appendAnalysisRunLogs,
  claimQueuedAnalysisRun,
  completeAnalysisRun,
  createAnalysisRun,
  failAnalysisRun,
  getAnalysisRun,
  listAnalysisRuns,
  persistAnalysisArtifact,
  persistAnalysisInteractions,
  persistAnalysisPages,
  persistFailureClusters,
  resetExpiredAnalysisRuns,
  setAnalysisRunAwaitingCheckpoint,
  touchAnalysisRunLease,
  updateAnalysisRunProgress,
} from "./runStore";
import { publishRunEvent, subscribeToRunEvents } from "./runEvents";
import { env } from "../../config/env";
import type {
  AnalysisRequest,
  AnalysisRunView,
  FailureCluster,
  FrontendAnalysis,
  InteractionResult,
  LoginPromptAction,
  LogLevel,
  PageAnalysis,
  PlatformAnalysisResult,
  ProgressUpdate,
  RunLogEntry,
} from "../../types/platform";

const WORKER_ID = `worker-${randomUUID()}`;
const activeRuns = new Set<string>();
const checkpointWaiters = new Map<
  string,
  {
    resolve: (action: LoginPromptAction) => void;
    reject: (error: Error) => void;
  }
>();
const runBuffers = new Map<string, RunPersistenceBuffer>();
let isDrainingQueue = false;

class DedicatedLoginSessionError extends Error {
  constructor() {
    super("Continued in dedicated login session");
    this.name = "DedicatedLoginSessionError";
  }
}

type RunPersistenceBuffer = {
  snapshot: AnalysisRunView;
  pendingProgress: ProgressUpdate | null;
  pendingPages: Map<string, PageAnalysis>;
  pendingInteractions: Map<string, InteractionResult>;
  pendingLogs: RunLogEntry[];
  pendingFailureClusters: FailureCluster[] | null;
  flushTimer?: NodeJS.Timeout;
  lastProgressFlushAt: number;
};

const initialProgress = (): ProgressUpdate => ({
  stageKey: "queued",
  stageLabel: "Queued",
  summary: "Waiting to start",
  technical: "Run has been created and is waiting for execution.",
});

const createRunBuffer = (run: AnalysisRunView): RunPersistenceBuffer => ({
  snapshot: {
    ...run,
    logs: [...run.logs],
    artifacts: [...run.artifacts],
    pages: [...run.pages],
    interactions: [...run.interactions],
    failureClusters: [...run.failureClusters],
  },
  pendingProgress: null,
  pendingPages: new Map(),
  pendingInteractions: new Map(),
  pendingLogs: [],
  pendingFailureClusters: null,
  lastProgressFlushAt: 0,
});

const getRunBuffer = (runId: string) => runBuffers.get(runId);

const ensureRunBuffer = (run: AnalysisRunView) => {
  const existing = runBuffers.get(run.runId);
  if (existing) {
    return existing;
  }

  const created = createRunBuffer(run);
  runBuffers.set(run.runId, created);
  return created;
};

const publishBufferedSnapshot = (runId: string) => {
  const buffer = getRunBuffer(runId);
  if (!buffer) {
    return;
  }

  buffer.snapshot.updatedAt = new Date().toISOString();
  publishRunEvent({
    ...buffer.snapshot,
    logs: buffer.snapshot.logs.slice(-120),
    artifacts: [],
    pages: [],
    interactions: [],
  });
};

const deriveExpectedDuration = ({
  request,
  progress,
  startedAt,
  fallback,
}: {
  request: AnalysisRequest;
  progress: ProgressUpdate;
  startedAt: string;
  fallback: number;
}) => {
  const elapsedSeconds = Math.max(1, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
  const maxPages = request.options?.maxPages ?? 10;
  const discoveredPages = progress.pagesDiscovered ?? 0;
  const detectedInteractions = progress.interactionsDetected ?? 0;
  const testedInteractions = progress.interactionsTested ?? 0;

  if (testedInteractions > 0 && detectedInteractions >= testedInteractions) {
    const perInteraction = elapsedSeconds / testedInteractions;
    const remainingInteractions = Math.max(detectedInteractions - testedInteractions, 0);
    return Math.max(elapsedSeconds + Math.round(remainingInteractions * perInteraction), elapsedSeconds + 5);
  }

  if (discoveredPages > 0) {
    const perPage = elapsedSeconds / discoveredPages;
    return Math.max(elapsedSeconds + Math.round(Math.max(maxPages - discoveredPages, 0) * perPage), fallback);
  }

  return fallback;
};

const estimateDuration = (request: AnalysisRequest) => {
  const maxPages = request.options?.maxPages ?? 10;
  const maxDepth = request.options?.maxDepth ?? 2;
  const maxInteractions = request.options?.maxInteractionsPerPage ?? 12;
  return Math.max(45, maxPages * 6 + maxDepth * 12 + maxInteractions * 2);
};

const createQueuedRun = async ({
  request,
  progress,
  parentRunId,
  retryOfRunId,
}: {
  request: AnalysisRequest;
  progress?: ProgressUpdate;
  parentRunId?: string;
  retryOfRunId?: string;
}) => {
  const runId = randomUUID();
  const expectedDurationSeconds = estimateDuration(request);

  const run = await createAnalysisRun({
    runId,
    request,
    progress: progress ?? initialProgress(),
    expectedDurationSeconds,
    parentRunId,
    retryOfRunId,
  });

  void drainQueue();
  return run;
};

export const startPlatformAnalysis = async (
  request: AnalysisRequest,
): Promise<AnalysisRunView> => createQueuedRun({ request, progress: initialProgress() });

const collectResumeArtifacts = (run: AnalysisRunView) => {
  const failedInteraction =
    [...(run.result?.frontend.interactionResults ?? run.interactions)]
      .reverse()
      .find((item) => item.result === "FAIL");
  const targetPageUrl = failedInteraction?.pageUrl ?? run.progress.currentPageUrl ?? run.pages.at(-1)?.url;
  const resumeMode = failedInteraction ? "failed_interaction" : "failed_page";
  const completedPageUrls = run.pages
    .filter((page) => !targetPageUrl || page.url !== targetPageUrl)
    .map((page) => page.url);
  const completedInteractionIds = (run.result?.frontend.interactionResults ?? run.interactions)
    .filter((interaction) => interaction.result === "PASS" && interaction.pageUrl !== targetPageUrl)
    .map((interaction) => interaction.buttonId);

  return {
    pageUrl: targetPageUrl,
    interactionId: failedInteraction?.buttonId,
    resumeMode: resumeMode as "failed_page" | "failed_interaction",
    completedPageUrls,
    completedInteractionIds,
  };
};

const mergeResumedFrontend = ({
  originalRun,
  resumedFrontend,
}: {
  originalRun: AnalysisRunView;
  resumedFrontend: FrontendAnalysis;
}): FrontendAnalysis => {
  const resumeFrom = resumedFrontend.baseUrl
    ? originalRun.request.options?.resumeFrom
    : undefined;
  if (!resumeFrom) {
    return resumedFrontend;
  }

  const priorFrontend = originalRun.result?.frontend;
  if (!priorFrontend) {
    return resumedFrontend;
  }

  const pages = [
    ...priorFrontend.pages.filter((page) => resumeFrom.completedPageUrls?.includes(page.url)),
    ...resumedFrontend.pages,
  ].filter((page, index, items) => items.findIndex((candidate) => candidate.url === page.url) === index);

  const interactionResults = [
    ...priorFrontend.interactionResults.filter((item) => resumeFrom.completedInteractionIds?.includes(item.buttonId)),
    ...resumedFrontend.interactionResults,
  ].filter((item, index, items) => items.findIndex((candidate) => candidate.buttonId === item.buttonId) === index);

  const navigationGraph = [
    ...priorFrontend.navigationGraph.filter((edge) => resumeFrom.completedInteractionIds?.includes(edge.interactionId ?? "")),
    ...resumedFrontend.navigationGraph,
  ];

  const interactiveElements = [
    ...priorFrontend.interactiveElements.filter((item) => resumeFrom.completedInteractionIds?.includes(item.id ?? "")),
    ...resumedFrontend.interactiveElements,
  ];

  const networkRequests = [...priorFrontend.networkRequests, ...resumedFrontend.networkRequests];
  const failureClusters = resumedFrontend.failureClusters;
  const runtimeFindings = [...priorFrontend.runtimeFindings, ...resumedFrontend.runtimeFindings];
  const scenarioResults = [...priorFrontend.scenarioResults, ...resumedFrontend.scenarioResults];
  const apiAssertions = [...priorFrontend.apiAssertions, ...resumedFrontend.apiAssertions];

  const passed = interactionResults.filter((item) => item.result === "PASS").length;
  const failed = interactionResults.filter((item) => item.result === "FAIL").length;

  return {
    ...resumedFrontend,
    pages,
    interactiveElements,
    interactionResults,
    navigationGraph,
    networkRequests,
    failureClusters,
    runtimeFindings,
    scenarioResults,
    apiAssertions,
    coverageReport: {
      total_buttons: interactiveElements.length,
      tested: interactionResults.length,
      passed,
      failed,
      coverage: interactiveElements.length === 0 ? "0%" : `${Math.round((interactionResults.length / interactiveElements.length) * 100)}%`,
    },
  };
};

export const retryPlatformAnalysis = async (runId: string): Promise<AnalysisRunView> => {
  const originalRun = await getAnalysisRun(runId);
  if (!originalRun) {
    throw new Error("run not found");
  }

  const resume = collectResumeArtifacts(originalRun);
  const request: AnalysisRequest = {
    ...originalRun.request,
    options: {
      ...originalRun.request.options,
      resumeFrom: {
        previousRunId: originalRun.runId,
        mode: resume.resumeMode,
        pageUrl: resume.pageUrl,
        interactionId: resume.interactionId,
        completedPageUrls: resume.completedPageUrls,
        completedInteractionIds: resume.completedInteractionIds,
      },
    },
  };

  const run = await createQueuedRun({
    request,
    progress: {
      ...initialProgress(),
      summary: resume.interactionId ? "Retrying failed interaction" : "Retrying failed page",
      technical: resume.pageUrl ?? "Retry run created from previous failure.",
      currentPageUrl: resume.pageUrl,
    },
    parentRunId: originalRun.parentRunId ?? originalRun.runId,
    retryOfRunId: originalRun.runId,
  });

  await logRun(run.runId, "retry", `created from ${originalRun.runId}`);
  return run;
};

export const startLoginSessionAnalysis = async (runId: string): Promise<AnalysisRunView> => {
  const originalRun = await getAnalysisRun(runId);
  if (!originalRun) {
    throw new Error("run not found");
  }

  if (originalRun.status !== "awaiting_checkpoint" || originalRun.progress.checkpoint?.kind !== "login_choice") {
    throw new Error("run is not waiting for a login decision");
  }

  const loginUrl =
    originalRun.progress.checkpoint?.loginUrl ??
    originalRun.progress.currentPageUrl ??
    originalRun.request.targetUrl;

  const nextRequest: AnalysisRequest = {
    ...originalRun.request,
    auth: {
      ...originalRun.request.auth,
      login: {
        url: loginUrl,
        headed: true,
        manualCheckpoint: {
          enabled: true,
          checkpointLabel: "Complete login",
          instructions: "Complete login or OTP in the visible crawler browser session, then continue the checkpoint.",
          timeoutSeconds: env.crawler.loginCheckpointTimeoutSeconds,
        },
      },
    },
    options: {
      ...originalRun.request.options,
      promptForLogin: false,
      loginPrompt: undefined,
    },
  };

  const waiter = checkpointWaiters.get(runId);
  if (waiter) {
    waiter.reject(new DedicatedLoginSessionError());
    checkpointWaiters.delete(runId);
  }

  const loginRun = await createQueuedRun({
    request: nextRequest,
    progress: {
      ...initialProgress(),
      summary: "Creating dedicated login session",
      technical: `Login session will open at ${loginUrl}`,
      currentPageUrl: loginUrl,
    },
    parentRunId: originalRun.parentRunId ?? originalRun.runId,
    retryOfRunId: originalRun.runId,
  });

  await logRun(loginRun.runId, "auth", `created dedicated login session from ${originalRun.runId}`);
  return loginRun;
};

export const getPlatformAnalysisRun = async (runId: string) => getAnalysisRun(runId);
export const listPlatformAnalysisRuns = async () => listAnalysisRuns();

const logRun = async (
  runId: string,
  scope: string,
  message: string,
  level: "info" | "warn" | "error" = "info",
) => {
  const line = `[analysis:${runId}] [${scope}] ${message}`;
  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }

  const buffer = getRunBuffer(runId);
  if (!buffer) {
    return;
  }

  const entry: RunLogEntry = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
  };
  buffer.snapshot.logs = [...buffer.snapshot.logs, entry].slice(-120);
  buffer.pendingLogs.push(entry);
  publishBufferedSnapshot(runId);

  if (buffer.pendingLogs.length >= env.analysis.logBatchSize) {
    try {
      await flushRunBuffer(runId, { force: true });
    } catch (error) {
      console.warn(`[analysis:${runId}] [log] skipped log persistence: ${toErrorMessage(error)}`);
    }
    return;
  }

  scheduleRunBufferFlush(runId, env.analysis.logFlushIntervalMs);
};

const toErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    if (
      "details" in error &&
      error.details &&
      typeof error.details === "object" &&
      "message" in error.details &&
      typeof error.details.message === "string"
    ) {
      return `${error.message}: ${error.details.message}`;
    }

    return error.message;
  }

  return "Analysis failed";
};

const scheduleRunBufferFlush = (runId: string, delayMs = env.analysis.progressFlushIntervalMs) => {
  const buffer = getRunBuffer(runId);
  if (!buffer) {
    return;
  }

  if (buffer.flushTimer) {
    clearTimeout(buffer.flushTimer);
  }

  buffer.flushTimer = setTimeout(() => {
    buffer.flushTimer = undefined;
    void flushRunBuffer(runId);
  }, delayMs);
};

const flushRunBuffer = async (runId: string, { force = false }: { force?: boolean } = {}) => {
  const buffer = getRunBuffer(runId);
  if (!buffer) {
    return;
  }

  const now = Date.now();
  const shouldFlushProgress =
    buffer.pendingProgress &&
    (force || now - buffer.lastProgressFlushAt >= env.analysis.progressFlushIntervalMs);

  const pendingPages = Array.from(buffer.pendingPages.values());
  const pendingInteractions = Array.from(buffer.pendingInteractions.values());
  const pendingLogs = [...buffer.pendingLogs];
  const pendingFailureClusters = buffer.pendingFailureClusters;

  if (pendingPages.length === 0 && pendingInteractions.length === 0 && pendingLogs.length === 0 && !shouldFlushProgress && !pendingFailureClusters) {
    return;
  }

  buffer.pendingPages.clear();
  buffer.pendingInteractions.clear();
  buffer.pendingLogs = [];
  buffer.pendingFailureClusters = null;
  if (shouldFlushProgress) {
    buffer.lastProgressFlushAt = now;
  }

  try {
    await Promise.all([
      pendingPages.length > 0
        ? persistAnalysisPages({
            runId,
            request: buffer.snapshot.request,
            pages: pendingPages,
          })
        : Promise.resolve(),
      pendingInteractions.length > 0
        ? persistAnalysisInteractions({
            runId,
            request: buffer.snapshot.request,
            interactions: pendingInteractions,
          })
        : Promise.resolve(),
      pendingLogs.length > 0
        ? appendAnalysisRunLogs({
            runId,
            request: buffer.snapshot.request,
            logs: pendingLogs.map((entry) => ({
              level: entry.level,
              scope: entry.scope,
              message: entry.message,
              timestamp: new Date(entry.timestamp),
            })),
          })
        : Promise.resolve(),
    ]);

    if (pendingFailureClusters) {
      await persistFailureClusters({ runId, failureClusters: pendingFailureClusters });
    }

    if (shouldFlushProgress && buffer.pendingProgress) {
      await updateAnalysisRunProgress({
        runId,
        status: buffer.snapshot.status,
        progress: buffer.pendingProgress,
        expectedDurationSeconds: buffer.snapshot.expectedDurationSeconds,
        workerId: WORKER_ID,
      });
      buffer.pendingProgress = null;
    }
  } catch (error) {
    for (const page of pendingPages) {
      buffer.pendingPages.set(page.url, page);
    }
    for (const interaction of pendingInteractions) {
      buffer.pendingInteractions.set(interaction.buttonId, interaction);
    }
    buffer.pendingLogs = [...pendingLogs, ...buffer.pendingLogs];
    buffer.pendingFailureClusters = pendingFailureClusters ?? buffer.pendingFailureClusters;
    if (shouldFlushProgress) {
      buffer.lastProgressFlushAt = 0;
    }
    throw error;
  }
};

const executePlatformAnalysis = async (run: AnalysisRunView) => {
  const { runId, request, expectedDurationSeconds } = run;
  activeRuns.add(runId);
  ensureRunBuffer(run);
  const leaseHeartbeat = setInterval(() => {
    void touchAnalysisRunLease(runId, WORKER_ID).catch((error) => {
      console.warn(`[analysis:${runId}] [lease] heartbeat failed: ${toErrorMessage(error)}`);
    });
  }, env.analysis.leaseHeartbeatIntervalMs);
  await logRun(runId, "queue", `started for ${request.targetUrl}`);

  try {
    const originalRun =
      request.options?.resumeFrom?.previousRunId
        ? await getAnalysisRun(request.options.resumeFrom.previousRunId)
        : null;

    const frontend = await crawlFrontend(request, runId, {
      onProgress: async (progress) => {
        const buffer = ensureRunBuffer(run);
        const dynamicExpectedDuration = deriveExpectedDuration({
          request,
          progress,
          startedAt: run.startedAt,
          fallback: expectedDurationSeconds ?? estimateDuration(request),
        });
        const nextProgress = {
          ...progress,
          expectedDurationSeconds: dynamicExpectedDuration,
        };
        buffer.snapshot.status = "running";
        buffer.snapshot.expectedDurationSeconds = dynamicExpectedDuration;
        buffer.snapshot.progress = nextProgress;
        buffer.pendingProgress = nextProgress;
        publishBufferedSnapshot(runId);
        scheduleRunBufferFlush(runId);
      },
      onPage: async (page) => {
        const buffer = ensureRunBuffer(run);
        buffer.pendingPages.set(page.url, page);
        buffer.snapshot.pages = [
          ...buffer.snapshot.pages.filter((item) => item.url !== page.url),
          page,
        ];
        buffer.snapshot.progress.pagesDiscovered = Math.max(
          buffer.snapshot.progress.pagesDiscovered ?? 0,
          buffer.snapshot.pages.length,
        );
        publishBufferedSnapshot(runId);
        scheduleRunBufferFlush(runId);
        if (page.previewImageUrl) {
          await persistAnalysisArtifact({
            runId,
            request,
            kind: "preview",
            publicUrl: page.previewImageUrl,
            relatedPageUrl: page.url,
          });
        }
        await logRun(runId, "crawl", `page ${page.routePath} stored`);
      },
      onInteraction: async (interaction) => {
        const buffer = ensureRunBuffer(run);
        buffer.pendingInteractions.set(interaction.buttonId, interaction);
        buffer.snapshot.interactions = [
          ...buffer.snapshot.interactions.filter((item) => item.buttonId !== interaction.buttonId),
          interaction,
        ];
        buffer.snapshot.progress.interactionsTested = Math.max(
          buffer.snapshot.progress.interactionsTested ?? 0,
          buffer.snapshot.interactions.length,
        );
        publishBufferedSnapshot(runId);
        if (buffer.pendingInteractions.size >= env.analysis.interactionBatchSize) {
          await flushRunBuffer(runId, { force: true });
        } else {
          scheduleRunBufferFlush(runId);
        }
        if (interaction.screenshotUrl) {
          await persistAnalysisArtifact({
            runId,
            request,
            kind: "interaction_failure",
            publicUrl: interaction.screenshotUrl,
            relatedPageUrl: interaction.pageUrl,
            relatedInteractionId: interaction.buttonId,
            absolutePath: interaction.screenshotPath,
          });
        }
        if (interaction.beforeScreenshotUrl) {
          await persistAnalysisArtifact({
            runId,
            request,
            kind: "interaction_before",
            publicUrl: interaction.beforeScreenshotUrl,
            relatedPageUrl: interaction.pageUrl,
            relatedInteractionId: interaction.buttonId,
          });
        }
        if (interaction.afterScreenshotUrl) {
          await persistAnalysisArtifact({
            runId,
            request,
            kind: "interaction_after",
            publicUrl: interaction.afterScreenshotUrl,
            relatedPageUrl: interaction.pageUrl,
            relatedInteractionId: interaction.buttonId,
          });
        }
      },
      onFailureClusters: async (failureClusters) => {
        const buffer = ensureRunBuffer(run);
        buffer.pendingFailureClusters = failureClusters;
        buffer.snapshot.failureClusters = failureClusters;
        publishBufferedSnapshot(runId);
        scheduleRunBufferFlush(runId);
      },
      waitForCheckpoint: async (checkpoint) => {
        const buffer = ensureRunBuffer(run);
        const nextProgress = {
          stageKey: "awaiting-checkpoint",
          stageLabel: "Awaiting checkpoint",
          summary: checkpoint.label,
          technical: checkpoint.instructions,
          currentPageUrl: checkpoint.currentPageUrl,
          expectedDurationSeconds,
          checkpoint: {
            kind: checkpoint.kind,
            label: checkpoint.label,
            instructions: checkpoint.instructions,
            expiresAt: checkpoint.expiresAt,
            loginUrl: checkpoint.loginUrl,
            allowedActions: checkpoint.allowedActions,
          },
          liveSession: checkpoint.liveSession,
        };
        buffer.snapshot.status = "awaiting_checkpoint";
        buffer.snapshot.progress = nextProgress;
        buffer.pendingProgress = nextProgress;
        publishBufferedSnapshot(runId);
        await flushRunBuffer(runId, { force: true });
        await setAnalysisRunAwaitingCheckpoint({
          runId,
          expectedDurationSeconds,
          workerId: WORKER_ID,
          progress: nextProgress,
        });
        await logRun(runId, "auth", checkpoint.instructions);

        const action = await new Promise<LoginPromptAction>((resolve, reject) => {
          checkpointWaiters.set(runId, { resolve, reject });
        });

        await logRun(runId, "auth", `checkpoint resumed with action: ${action}`);
        return action;
      },
      onWarning: async (message) => {
        await logRun(runId, "crawler", message, "warn");
      },
    });

    const mergedFrontend = originalRun
      ? mergeResumedFrontend({
          originalRun,
          resumedFrontend: frontend,
        })
      : frontend;

    const testCases = generateTestCases(mergedFrontend);
    const backendValidation = validateBackendInput(request, mergedFrontend);
    const report = buildReport({
      runId,
      frontend: mergedFrontend,
      testCases,
      backendValidation,
    });

    const result: PlatformAnalysisResult = {
      runId,
      request,
      frontend: mergedFrontend,
      testCases,
      backendValidation,
      report,
    };

    for (const scenario of mergedFrontend.scenarioResults) {
      if (!scenario.screenshotUrl) {
        continue;
      }

      await persistAnalysisArtifact({
        runId,
        request,
        kind: scenario.pack === "forms" || scenario.pack === "pagination" ? "boundary" : "scenario",
        publicUrl: scenario.screenshotUrl,
        relatedPageUrl: scenario.pageUrl,
      });
    }

    for (const finding of mergedFrontend.runtimeFindings) {
      if (!finding.screenshotUrl) {
        continue;
      }

      await persistAnalysisArtifact({
        runId,
        request,
        kind: finding.type === "boundary_limit" ? "boundary" : "scenario",
        publicUrl: finding.screenshotUrl,
        relatedPageUrl: finding.pageUrl,
        relatedInteractionId: finding.relatedInteractionId,
      });
    }

    const buffer = ensureRunBuffer(run);
    buffer.pendingProgress = {
      ...buffer.snapshot.progress,
      expectedDurationSeconds: mergedFrontend.pages.length > 0 ? Math.max(elapsedToSeconds(run.startedAt), expectedDurationSeconds ?? 0) : expectedDurationSeconds,
      pagesDiscovered: mergedFrontend.pages.length,
      completedPages: mergedFrontend.pages.length,
      interactionsDetected: mergedFrontend.interactiveElements.length,
      interactionsTested: mergedFrontend.interactionResults.length,
    };
    await flushRunBuffer(runId, { force: true });

    const completedProgress = {
      stageKey: "completed",
      stageLabel: "Completed",
      summary: "Analysis finished",
      technical: "All crawl, interaction, and report steps completed successfully.",
      expectedDurationSeconds: mergedFrontend.pages.length > 0 ? Math.max(elapsedToSeconds(run.startedAt), expectedDurationSeconds ?? 0) : expectedDurationSeconds,
      pagesDiscovered: mergedFrontend.pages.length,
      completedPages: mergedFrontend.pages.length,
      interactionsDetected: mergedFrontend.interactiveElements.length,
      interactionsTested: mergedFrontend.interactionResults.length,
      lastSuccessfulAction: [...mergedFrontend.interactionResults]
        .reverse()
        .find((item) => item.result === "PASS")
        ? {
            label: [...mergedFrontend.interactionResults].reverse().find((item) => item.result === "PASS")!.text,
            pageUrl: [...mergedFrontend.interactionResults].reverse().find((item) => item.result === "PASS")!.pageUrl,
            interactionId: [...mergedFrontend.interactionResults].reverse().find((item) => item.result === "PASS")!.buttonId,
            at: new Date().toISOString(),
          }
        : undefined,
      pagesPreview: mergedFrontend.pages.slice(0, 6).map((page) => ({
        url: page.url,
        title: page.title,
        routePath: page.routePath,
        interactiveCount: page.buttons.length + page.links.length + page.inputs.length,
        headings: page.headings.slice(0, 3),
        buttons: page.buttons.slice(0, 4).map((item) => item.text || item.selector),
        links: page.links.slice(0, 4).map((item) => item.text || item.selector),
        previewImageUrl: page.previewImageUrl,
        htmlPreview: page.htmlPreview,
      })),
      liveSession: mergedFrontend.pages.at(-1)
        ? {
            url: mergedFrontend.pages.at(-1)!.url,
            title: mergedFrontend.pages.at(-1)!.title,
            html: mergedFrontend.pages.at(-1)!.htmlPreview,
            previewImageUrl: mergedFrontend.pages.at(-1)!.previewImageUrl,
            capturedAt: new Date().toISOString(),
            consoleEvents: buffer.snapshot.progress.liveSession?.consoleEvents ?? [],
            networkEvents:
              buffer.snapshot.progress.liveSession?.networkEvents ??
              mergedFrontend.networkRequests.slice(-8).map((entry) => `${entry.method} ${entry.url}`),
          }
        : undefined,
    };

    await completeAnalysisRun({
      runId,
      result,
      progress: completedProgress,
    });
    buffer.snapshot.status = "completed";
    buffer.snapshot.progress = completedProgress;
    await logRun(runId, "queue", "completed");
  } catch (error) {
    if (error instanceof DedicatedLoginSessionError) {
      await logRun(runId, "auth", "handoff to dedicated login session completed");
      const handedOffProgress = {
        stageKey: "handoff",
        stageLabel: "Moved to login session",
        summary: "Continued in dedicated login session",
        technical: "This run handed off to a dedicated login session for authentication.",
        expectedDurationSeconds,
      };
      await failAnalysisRun({
        runId,
        error: error.message,
        progress: handedOffProgress,
      });
      const buffer = ensureRunBuffer(run);
      buffer.snapshot.status = "failed";
      buffer.snapshot.error = error.message;
      buffer.snapshot.progress = handedOffProgress;
      return;
    }

    const message = toErrorMessage(error);
    await logRun(runId, "queue", `failed: ${message}`, "error");
    const failedProgress = {
      stageKey: "failed",
      stageLabel: "Failed",
      summary: "Analysis stopped",
      technical: message,
      expectedDurationSeconds,
    };
    await failAnalysisRun({
      runId,
      error: message,
      progress: failedProgress,
    });
    const buffer = ensureRunBuffer(run);
    buffer.snapshot.status = "failed";
    buffer.snapshot.error = message;
    buffer.snapshot.progress = failedProgress;
  } finally {
    clearInterval(leaseHeartbeat);
    const buffer = getRunBuffer(runId);
    if (buffer?.flushTimer) {
      clearTimeout(buffer.flushTimer);
    }
    runBuffers.delete(runId);
    checkpointWaiters.delete(runId);
    activeRuns.delete(runId);
  }
};

const elapsedToSeconds = (startedAt: string) =>
  Math.max(1, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));

const drainQueue = async () => {
  if (isDrainingQueue || activeRuns.size >= env.analysis.maxConcurrentRuns) {
    return;
  }

  isDrainingQueue = true;
  try {
    const availableSlots = env.analysis.maxConcurrentRuns - activeRuns.size;

    for (let index = 0; index < availableSlots; index += 1) {
      const run = await claimQueuedAnalysisRun(WORKER_ID);
      if (!run) {
        break;
      }

      void executePlatformAnalysis(run);
    }
  } finally {
    isDrainingQueue = false;
  }
};

export const initializeAnalysisWorker = () => {
  void resetExpiredAnalysisRuns().then(() => drainQueue());
  setInterval(() => {
    void resetExpiredAnalysisRuns().then(() => drainQueue());
  }, env.analysis.queuePollIntervalMs);
};

export const continueAnalysisCheckpoint = async (
  runId: string,
  action: LoginPromptAction = "continue_after_login",
) => {
  const waiter = checkpointWaiters.get(runId);
  if (!waiter) {
    return false;
  }

  waiter.resolve(action);
  checkpointWaiters.delete(runId);
  return true;
};

export const streamPlatformAnalysisRun = async (runId: string, res: Response) => {
  const snapshot = await getAnalysisRun(runId);
  if (!snapshot) {
    return false;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const write = (payload: AnalysisRunView) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  write(snapshot);

  const unsubscribe = subscribeToRunEvents(runId, write);
  const heartbeat = setInterval(() => {
    res.write(": keepalive\n\n");
  }, env.analysis.streamHeartbeatIntervalMs);

  res.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });

  return true;
};
