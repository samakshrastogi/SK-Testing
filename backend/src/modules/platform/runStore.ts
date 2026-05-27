import { randomUUID } from "crypto";
import path from "path";
import { AnalysisArtifactModel } from "../../models/AnalysisArtifact";
import { AnalysisInteractionModel } from "../../models/AnalysisInteraction";
import { AnalysisLogModel } from "../../models/AnalysisLog";
import { AnalysisPageModel } from "../../models/AnalysisPage";
import { AnalysisRunModel } from "../../models/AnalysisRun";
import type {
  AnalysisRequest,
  AnalysisRunStatus,
  AnalysisRunView,
  ArtifactRecord,
  FailureCluster,
  InteractionResult,
  LogLevel,
  PageAnalysis,
  PlatformAnalysisResult,
  ProgressUpdate,
  RunLogEntry,
} from "../../types/platform";
import { publishRunEvent } from "./runEvents";
import { env } from "../../config/env";

type CreateRunInput = {
  runId: string;
  request: AnalysisRequest;
  progress: ProgressUpdate;
  expectedDurationSeconds?: number;
  parentRunId?: string;
  retryOfRunId?: string;
};

const LEASE_WINDOW_MS = 90_000;
const MONGO_RETRY_LIMIT = 3;
const MAX_PAGE_HTML_PREVIEW_CHARS = 12_000;
const MAX_LIVE_SESSION_HTML_CHARS = 8_000;
const MAX_TEXT_SNIPPET_CHARS = 4_000;
const MAX_COLLECTION_PREVIEW_ITEMS = 80;

const toArtifactRelativePath = (publicUrl: string) => {
  const routePrefix = `${env.runtime.artifactsPublicRoute}/`;
  if (publicUrl.startsWith(routePrefix)) {
    return publicUrl.slice(routePrefix.length);
  }

  return publicUrl.replace(/^\/+/, "");
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableMongoError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const candidate = error as Error & {
    code?: string;
    cause?: { code?: string; message?: string };
    errorLabels?: string[];
  };
  const message = `${candidate.name} ${candidate.message} ${candidate.cause?.message ?? ""}`.toLowerCase();
  const code = candidate.code ?? candidate.cause?.code;

  return (
    candidate.name.includes("Mongo") &&
    (
      code === "ECONNRESET" ||
      code === "ETIMEDOUT" ||
      code === "EPIPE" ||
      message.includes("econnreset") ||
      message.includes("timed out") ||
      message.includes("connection") ||
      candidate.errorLabels?.includes("RetryableWriteError") === true
    )
  );
};

const withMongoRetry = async <T>(
  label: string,
  operation: () => Promise<T>,
  attempt = 1,
  maxAttempts = MONGO_RETRY_LIMIT,
): Promise<T> => {
  try {
    return await operation();
  } catch (error) {
    if (!isRetryableMongoError(error) || attempt >= maxAttempts) {
      throw error;
    }

    const delayMs = attempt * 250;
    console.warn(`[mongo] ${label} failed (${(error as Error).message}). Retrying in ${delayMs}ms.`);
    await sleep(delayMs);
    return withMongoRetry(label, operation, attempt + 1, maxAttempts);
  }
};

const getTargetDomain = (request: AnalysisRequest) => {
  try {
    return new URL(request.targetUrl).hostname;
  } catch {
    return request.targetUrl;
  }
};

const truncateText = (value: string | undefined, max: number) => {
  if (!value) {
    return value;
  }

  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, Math.max(0, max - 24))}\n...[truncated]`;
};

const trimStringList = (values: string[] | undefined, maxItems = MAX_COLLECTION_PREVIEW_ITEMS, maxChars = 400) =>
  (values ?? []).slice(0, maxItems).map((value) => truncateText(value, maxChars) ?? "");

const sanitizePageAnalysis = (page: PageAnalysis): PageAnalysis => ({
  ...page,
  headings: trimStringList(page.headings, 40, 240),
  discoveredLinks: trimStringList(page.discoveredLinks, 120, 500),
  interactionNotes: trimStringList(page.interactionNotes, 80, 500),
  htmlPreview: truncateText(page.htmlPreview, MAX_PAGE_HTML_PREVIEW_CHARS),
});

const sanitizePagesPreview = (pagesPreview: ProgressUpdate["pagesPreview"]) =>
  pagesPreview?.slice(0, 12).map((page) => ({
    ...page,
    headings: trimStringList(page.headings, 6, 160),
    buttons: trimStringList(page.buttons, 10, 160),
    links: trimStringList(page.links, 10, 160),
    htmlPreview: truncateText(page.htmlPreview, 2_500),
  }));

const sanitizeLiveSession = (liveSession: ProgressUpdate["liveSession"]) => {
  if (!liveSession) {
    return liveSession;
  }

  return {
    ...liveSession,
    html: truncateText(liveSession.html, MAX_LIVE_SESSION_HTML_CHARS),
    consoleEvents: trimStringList(liveSession.consoleEvents, 30, 240),
    networkEvents: trimStringList(liveSession.networkEvents, 30, 240),
  };
};

const sanitizeProgress = (progress: ProgressUpdate): ProgressUpdate => ({
  ...progress,
  technical: truncateText(progress.technical, 2_000) ?? progress.technical,
  pagesPreview: sanitizePagesPreview(progress.pagesPreview),
  liveSession: sanitizeLiveSession(progress.liveSession),
});

const sanitizeInteractionResult = (interaction: InteractionResult): InteractionResult => ({
  ...interaction,
  beforeDomSnippet: truncateText(interaction.beforeDomSnippet, MAX_TEXT_SNIPPET_CHARS),
  afterDomSnippet: truncateText(interaction.afterDomSnippet, MAX_TEXT_SNIPPET_CHARS),
  domDiffSummary: truncateText(interaction.domDiffSummary, 2_000),
  passReasons: trimStringList(interaction.passReasons, 12, 240),
});

const sanitizePlatformAnalysisResult = (result: PlatformAnalysisResult): PlatformAnalysisResult => ({
  ...result,
  frontend: {
    ...result.frontend,
    pages: result.frontend.pages.map(sanitizePageAnalysis),
    interactionResults: result.frontend.interactionResults.map(sanitizeInteractionResult),
    warnings: trimStringList(result.frontend.warnings, 80, 400),
  },
  report: {
    ...result.report,
    mermaidFlowchart: truncateText(result.report.mermaidFlowchart, 20_000) ?? result.report.mermaidFlowchart,
    pdfOutline: trimStringList(result.report.pdfOutline, 200, 400),
  },
});

const toArtifactView = (doc: any): ArtifactRecord => ({
  artifactId: doc.artifactId,
  runId: doc.runId,
  kind: doc.kind,
  relatedPageUrl: doc.relatedPageUrl ?? undefined,
  relatedInteractionId: doc.relatedInteractionId ?? undefined,
  fileName: doc.fileName,
  absolutePath: doc.absolutePath,
  publicUrl: doc.publicUrl,
  createdAt: new Date(doc.createdAt).toISOString(),
});

type ViewOptions = {
  includePages?: boolean;
  includeInteractions?: boolean;
  includeLogs?: boolean;
  includeArtifacts?: boolean;
};

const toView = async (
  doc: any,
  {
    includePages = true,
    includeInteractions = true,
    includeLogs = true,
    includeArtifacts = true,
  }: ViewOptions = {},
): Promise<AnalysisRunView> => {
  const [pageDocs, interactionDocs, logDocs, artifactDocs] = await withMongoRetry(`toView:${doc.runId}`, () =>
    Promise.all([
      includePages ? AnalysisPageModel.find({ runId: doc.runId }).sort({ createdAt: 1 }).lean() : Promise.resolve([]),
      includeInteractions
        ? AnalysisInteractionModel.find({ runId: doc.runId }).sort({ createdAt: 1 }).lean()
        : Promise.resolve([]),
      includeLogs ? AnalysisLogModel.find({ runId: doc.runId }).sort({ timestamp: 1 }).limit(120).lean() : Promise.resolve([]),
      includeArtifacts
        ? AnalysisArtifactModel.find({ runId: doc.runId }).sort({ createdAt: 1 }).lean()
        : Promise.resolve([]),
    ]),
  );

  const startedAt = new Date(doc.startedAt);
  const completedAt = doc.completedAt ? new Date(doc.completedAt) : undefined;
  const updatedAt = new Date(doc.updatedAt);
  const end = completedAt ?? updatedAt;

  return {
    runId: doc.runId,
    status: doc.status,
    parentRunId: doc.parentRunId ?? undefined,
    retryOfRunId: doc.retryOfRunId ?? undefined,
    request: doc.request,
    startedAt: startedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    completedAt: completedAt?.toISOString(),
    elapsedSeconds: Math.max(0, Math.round((end.getTime() - startedAt.getTime()) / 1000)),
    expectedDurationSeconds: doc.expectedDurationSeconds ?? undefined,
    progress: doc.progress,
    logs: logDocs.map((logDoc) => ({
      logId: String(logDoc._id),
      timestamp: new Date(logDoc.timestamp).toISOString(),
      level: logDoc.level,
      scope: logDoc.scope,
      message: logDoc.message,
    })) as RunLogEntry[],
    artifacts: artifactDocs.map(toArtifactView),
    pages: pageDocs.map((pageDoc) => pageDoc.snapshot as PageAnalysis),
    interactions: interactionDocs.map((interactionDoc) => interactionDoc.result as InteractionResult),
    failureClusters: (doc.failureClusters ?? []) as FailureCluster[],
    result: doc.result ?? undefined,
    error: doc.error ?? undefined,
  };
};

const toLiveView = async (
  doc: any,
  options: Pick<ViewOptions, "includeLogs"> = {},
): Promise<AnalysisRunView> =>
  toView(doc, {
    includePages: false,
    includeInteractions: false,
    includeArtifacts: false,
    includeLogs: options.includeLogs ?? false,
  });

const toListView = (doc: any): AnalysisRunView => {
  const startedAt = new Date(doc.startedAt);
  const completedAt = doc.completedAt ? new Date(doc.completedAt) : undefined;
  const updatedAt = new Date(doc.updatedAt);
  const end = completedAt ?? updatedAt;

  return {
    runId: doc.runId,
    status: doc.status,
    parentRunId: doc.parentRunId ?? undefined,
    retryOfRunId: doc.retryOfRunId ?? undefined,
    request: doc.request,
    startedAt: startedAt.toISOString(),
    updatedAt: updatedAt.toISOString(),
    completedAt: completedAt?.toISOString(),
    elapsedSeconds: Math.max(0, Math.round((end.getTime() - startedAt.getTime()) / 1000)),
    expectedDurationSeconds: doc.expectedDurationSeconds ?? undefined,
    progress: doc.progress,
    logs: [],
    artifacts: [],
    pages: [],
    interactions: [],
    failureClusters: (doc.failureClusters ?? []) as FailureCluster[],
    result: doc.result ?? undefined,
    error: doc.error ?? undefined,
  };
};

const updateLease = (workerId?: string) => ({
  workerId,
  leaseExpiresAt: workerId ? new Date(Date.now() + LEASE_WINDOW_MS) : undefined,
});

export const createAnalysisRun = async ({
  runId,
  request,
  progress,
  expectedDurationSeconds,
  parentRunId,
  retryOfRunId,
}: CreateRunInput): Promise<AnalysisRunView> => {
  const doc = await AnalysisRunModel.create({
    runId,
    status: "queued",
    targetDomain: getTargetDomain(request),
    parentRunId,
    retryOfRunId,
    request,
    progress: sanitizeProgress(progress),
    expectedDurationSeconds,
    startedAt: new Date(),
    failureClusters: [],
  });

  const view = await toLiveView(doc);
  publishRunEvent(view);
  return view;
};

export const claimQueuedAnalysisRun = async (workerId: string): Promise<AnalysisRunView | null> => {
  const doc = await withMongoRetry("claimQueuedAnalysisRun", () =>
    AnalysisRunModel.findOneAndUpdate(
      { status: "queued" },
      {
        $set: {
          status: "running",
          ...updateLease(workerId),
        },
      },
      {
        sort: { createdAt: -1 },
        returnDocument: "after",
      },
    ),
  );

  if (!doc) {
    return null;
  }

  const view = await toLiveView(doc);
  publishRunEvent(view);
  return view;
};

export const resetExpiredAnalysisRuns = async () => {
  await withMongoRetry("resetExpiredAnalysisRuns", () =>
    AnalysisRunModel.updateMany(
      {
        status: { $in: ["running", "awaiting_checkpoint"] },
        leaseExpiresAt: { $lt: new Date() },
      },
      {
        $set: {
          status: "queued",
          workerId: undefined,
          leaseExpiresAt: undefined,
          progress: {
            stageKey: "queued",
            stageLabel: "Queued",
            summary: "Recovered after restart",
            technical: "The previous worker lease expired, so the run was re-queued.",
          },
        },
      },
    ),
  );
};

export const updateAnalysisRunProgress = async ({
  runId,
  status,
  progress,
  expectedDurationSeconds,
  workerId,
}: {
  runId: string;
  status: AnalysisRunStatus;
  progress: ProgressUpdate;
  expectedDurationSeconds?: number;
  workerId?: string;
}) => {
  const sanitizedProgress = sanitizeProgress(progress);
  const doc = await withMongoRetry(`updateAnalysisRunProgress:${runId}`, () =>
    AnalysisRunModel.findOneAndUpdate(
      { runId },
      {
        $set: {
          status,
          progress: sanitizedProgress,
          expectedDurationSeconds,
          ...updateLease(workerId),
        },
      },
      { returnDocument: "after" },
    ),
  );

  if (!doc) {
    return null;
  }

  const view = await toLiveView(doc);
  publishRunEvent(view);
  return view;
};

export const touchAnalysisRunLease = async (runId: string, workerId: string) =>
  withMongoRetry(
    `touchAnalysisRunLease:${runId}`,
    () =>
      AnalysisRunModel.findOneAndUpdate(
        { runId, status: { $in: ["running", "awaiting_checkpoint"] } },
        {
          $set: {
            ...updateLease(workerId),
          },
        },
        { returnDocument: "after" },
      ),
    1,
    2,
  );

export const setAnalysisRunAwaitingCheckpoint = async ({
  runId,
  progress,
  expectedDurationSeconds,
  workerId,
}: {
  runId: string;
  progress: ProgressUpdate;
  expectedDurationSeconds?: number;
  workerId?: string;
}) =>
  updateAnalysisRunProgress({
    runId,
    status: "awaiting_checkpoint",
    progress,
    expectedDurationSeconds,
    workerId,
  });

export const persistAnalysisPage = async ({
  runId,
  request,
  page,
}: {
  runId: string;
  request: AnalysisRequest;
  page: PageAnalysis;
}) => {
  const sanitizedPage = sanitizePageAnalysis(page);
  await withMongoRetry(`persistAnalysisPage:${runId}:${page.url}`, () =>
    AnalysisPageModel.findOneAndUpdate(
      { runId, url: page.url },
      {
        $set: {
          targetDomain: getTargetDomain(request),
          routePath: sanitizedPage.routePath,
          depth: sanitizedPage.depth,
          snapshot: sanitizedPage,
        },
      },
      {
        upsert: true,
        returnDocument: "after",
      },
    ),
  );
};

export const persistAnalysisPages = async ({
  runId,
  request,
  pages,
}: {
  runId: string;
  request: AnalysisRequest;
  pages: PageAnalysis[];
}) => {
  if (pages.length === 0) {
    return;
  }

  const sanitizedPages = pages.map(sanitizePageAnalysis);
  await withMongoRetry(`persistAnalysisPages:${runId}`, () =>
    AnalysisPageModel.bulkWrite(
      sanitizedPages.map((page) => ({
        updateOne: {
          filter: { runId, url: page.url },
          update: {
            $set: {
              targetDomain: getTargetDomain(request),
              routePath: page.routePath,
              depth: page.depth,
              snapshot: page,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    ),
  );
};

export const persistAnalysisInteraction = async ({
  runId,
  request,
  interaction,
}: {
  runId: string;
  request: AnalysisRequest;
  interaction: InteractionResult;
}) => {
  const sanitizedInteraction = sanitizeInteractionResult(interaction);
  await withMongoRetry(`persistAnalysisInteraction:${runId}:${interaction.buttonId}`, () =>
    AnalysisInteractionModel.findOneAndUpdate(
      { runId, buttonId: interaction.buttonId },
      {
        $set: {
          targetDomain: getTargetDomain(request),
          pageUrl: sanitizedInteraction.pageUrl,
          result: sanitizedInteraction,
        },
      },
      {
        upsert: true,
        returnDocument: "after",
      },
    ),
  );
};

export const persistAnalysisInteractions = async ({
  runId,
  request,
  interactions,
}: {
  runId: string;
  request: AnalysisRequest;
  interactions: InteractionResult[];
}) => {
  if (interactions.length === 0) {
    return;
  }

  const sanitizedInteractions = interactions.map(sanitizeInteractionResult);
  await withMongoRetry(`persistAnalysisInteractions:${runId}`, () =>
    AnalysisInteractionModel.bulkWrite(
      sanitizedInteractions.map((interaction) => ({
        updateOne: {
          filter: { runId, buttonId: interaction.buttonId },
          update: {
            $set: {
              targetDomain: getTargetDomain(request),
              pageUrl: interaction.pageUrl,
              result: interaction,
            },
          },
          upsert: true,
        },
      })),
      { ordered: false },
    ),
  );
};

export const persistFailureClusters = async ({
  runId,
  failureClusters,
}: {
  runId: string;
  failureClusters: FailureCluster[];
}) => {
  const doc = await withMongoRetry(`persistFailureClusters:${runId}`, () =>
    AnalysisRunModel.findOneAndUpdate(
      { runId },
      {
        $set: {
          failureClusters,
        },
      },
      {
        returnDocument: "after",
      },
    ),
  );

  if (!doc) {
    return null;
  }

  const view = await toLiveView(doc);
  publishRunEvent(view);
  return view;
};

export const completeAnalysisRun = async ({
  runId,
  result,
  progress,
}: {
  runId: string;
  result: PlatformAnalysisResult;
  progress: ProgressUpdate;
}) => {
  const sanitizedResult = sanitizePlatformAnalysisResult(result);
  const sanitizedProgress = sanitizeProgress(progress);
  const doc = await withMongoRetry(`completeAnalysisRun:${runId}`, () =>
    AnalysisRunModel.findOneAndUpdate(
      { runId },
      {
        $set: {
          status: "completed",
          result: sanitizedResult,
          progress: sanitizedProgress,
          completedAt: new Date(),
          workerId: undefined,
          leaseExpiresAt: undefined,
          failureClusters: sanitizedResult.frontend.failureClusters,
        },
      },
      { returnDocument: "after" },
    ),
    1,
    6,
  );

  if (!doc) {
    return null;
  }

  const view = await toLiveView(doc, { includeLogs: true });
  publishRunEvent(view);
  return view;
};

export const failAnalysisRun = async ({
  runId,
  error,
  progress,
}: {
  runId: string;
  error: string;
  progress: ProgressUpdate;
}) => {
  const sanitizedProgress = sanitizeProgress(progress);
  const doc = await withMongoRetry(`failAnalysisRun:${runId}`, () =>
    AnalysisRunModel.findOneAndUpdate(
      { runId },
      {
        $set: {
          status: "failed",
          error,
          progress: sanitizedProgress,
          completedAt: new Date(),
          workerId: undefined,
          leaseExpiresAt: undefined,
        },
      },
      { returnDocument: "after" },
    ),
    1,
    6,
  );

  if (!doc) {
    return null;
  }

  const view = await toView(doc);
  publishRunEvent(view);
  return view;
};

export const getAnalysisRun = async (runId: string): Promise<AnalysisRunView | null> => {
  const doc = await withMongoRetry(`getAnalysisRun:${runId}`, () =>
    AnalysisRunModel.findOne({ runId }).lean(),
  );
  if (!doc) {
    return null;
  }

  return toView(doc);
};

export const appendAnalysisRunLog = async ({
  runId,
  request,
  level,
  scope,
  message,
}: {
  runId: string;
  request?: AnalysisRequest;
  level: LogLevel;
  scope: string;
  message: string;
}) => {
  let targetDomain = request ? getTargetDomain(request) : undefined;
  if (!targetDomain) {
    const run = await withMongoRetry(`appendAnalysisRunLog:targetDomain:${runId}`, () =>
      AnalysisRunModel.findOne({ runId }).select("targetDomain").lean(),
    );
    targetDomain = run?.targetDomain;
  }

  await AnalysisLogModel.create({
    runId,
    targetDomain: targetDomain ?? "unknown",
    level,
    scope,
    message,
    timestamp: new Date(),
  });

  const doc = await withMongoRetry(`appendAnalysisRunLog:run:${runId}`, () =>
    AnalysisRunModel.findOne({ runId }),
  );

  if (!doc) {
    return null;
  }

  const view = await toView(doc);
  publishRunEvent(view);
  return view;
};

export const appendAnalysisRunLogs = async ({
  runId,
  request,
  logs,
}: {
  runId: string;
  request?: AnalysisRequest;
  logs: Array<{
    level: LogLevel;
    scope: string;
    message: string;
    timestamp?: Date;
  }>;
}) => {
  if (logs.length === 0) {
    return;
  }

  let targetDomain = request ? getTargetDomain(request) : undefined;
  if (!targetDomain) {
    const run = await withMongoRetry(`appendAnalysisRunLogs:targetDomain:${runId}`, () =>
      AnalysisRunModel.findOne({ runId }).select("targetDomain").lean(),
    );
    targetDomain = run?.targetDomain;
  }

  await withMongoRetry(`appendAnalysisRunLogs:${runId}`, () =>
    AnalysisLogModel.insertMany(
      logs.map((entry) => ({
        runId,
        targetDomain: targetDomain ?? "unknown",
        level: entry.level,
        scope: entry.scope,
        message: entry.message,
        timestamp: entry.timestamp ?? new Date(),
      })),
      { ordered: false },
    ),
  );
};

export const listAnalysisRuns = async (): Promise<AnalysisRunView[]> => {
  const docs = await withMongoRetry("listAnalysisRuns", () =>
    AnalysisRunModel.find().sort({ updatedAt: -1 }).limit(50).lean(),
  );
  return docs.map(toListView);
};

export const persistAnalysisArtifact = async ({
  runId,
  request,
  kind,
  publicUrl,
  relatedPageUrl,
  relatedInteractionId,
  absolutePath,
}: {
  runId: string;
  request: AnalysisRequest;
  kind: ArtifactRecord["kind"];
  publicUrl: string;
  relatedPageUrl?: string;
  relatedInteractionId?: string;
  absolutePath?: string;
}) => {
  const artifactId = `${runId}:${kind}:${relatedInteractionId ?? relatedPageUrl ?? publicUrl}`;
  const resolvedAbsolutePath =
    absolutePath ??
    path.resolve(process.cwd(), env.runtime.artifactsDir, toArtifactRelativePath(publicUrl).replace(/\//g, path.sep));
  const retentionDays = env.artifacts.retentionDays;

  await withMongoRetry(`persistAnalysisArtifact:${artifactId}`, () =>
    AnalysisArtifactModel.findOneAndUpdate(
      { artifactId },
      {
        $set: {
          runId,
          targetDomain: getTargetDomain(request),
          kind,
          relatedPageUrl,
          relatedInteractionId,
          fileName: path.basename(resolvedAbsolutePath),
          absolutePath: resolvedAbsolutePath,
          publicUrl,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + retentionDays * 24 * 60 * 60 * 1000),
        },
      },
      {
        upsert: true,
        returnDocument: "after",
      },
    ),
  );
};
