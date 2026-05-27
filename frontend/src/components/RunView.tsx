import { useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";
import { createPortal } from "react-dom";
import { runtime } from "../config/runtime";
import { AnalysisForm } from "./AnalysisForm";
import type { AnalysisResponse, AnalysisRun, SavedProject } from "../types/analysis";

type MetricSnapshot = {
  pages: number;
  detected: number;
  tested: number;
  failures: number;
  elapsed: number;
};

type RunIntelligence = {
  overview: string;
  did: string[];
  scope: string[];
  websiteInsights: string[];
  limitations: string[];
  nextSteps: string[];
  confidence: {
    level: "High" | "Medium" | "Low";
    summary: string;
    reasons: string[];
  };
};

type RunSummaryStrip = {
  result: string;
  coverage: string;
  limitation: string;
  impact: string;
};

type RunViewProps = {
  targetUrl: string;
  repoUrl: string;
  uploadedPath: string;
  loading: boolean;
  error: string;
  urlError: string;
  currentRun: AnalysisRun | null;
  savedProjects: SavedProject[];
  onRetryRun: (runId: string) => Promise<void>;
  onReplaceRun: (run: AnalysisRun) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onTargetUrlChange: (value: string) => void;
  onRepoUrlChange: (value: string) => void;
  onUploadedPathChange: (value: string) => void;
};

const API_BASE_URL = runtime.apiBaseUrl;
const ANALYSIS_API_BASE_URL = `${runtime.apiBaseUrl}${runtime.analysisApiPath}`;

export function RunView({
  currentRun,
  onRetryRun,
  onReplaceRun,
  ...props
}: RunViewProps) {
  const [now, setNow] = useState(Date.now());
  const [previewModalOpen, setPreviewModalOpen] = useState(false);
  const [loginDecisionHandled, setLoginDecisionHandled] = useState<string | null>(null);
  const [dismissedErrorKey, setDismissedErrorKey] = useState<string | null>(null);

  useEffect(() => {
    if (!currentRun || currentRun.status === "completed" || currentRun.status === "failed") {
      return;
    }

    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [currentRun]);

  const elapsedSeconds = useMemo(() => {
    if (!currentRun) {
      return 0;
    }

    const startedAt = new Date(currentRun.startedAt).getTime();
    const endTime =
      currentRun.status === "completed" || currentRun.status === "failed"
        ? new Date(currentRun.updatedAt).getTime()
        : now;

    return Math.max(0, Math.floor((endTime - startedAt) / 1000));
  }, [currentRun, now]);

  const remainingSeconds = currentRun?.expectedDurationSeconds
    ? Math.max(currentRun.expectedDurationSeconds - elapsedSeconds, 0)
    : null;

  const heroPreview = currentRun?.progress.liveSession ?? (currentRun?.progress.pagesPreview?.[0]
    ? {
        url: currentRun.progress.pagesPreview[0].url,
        title: currentRun.progress.pagesPreview[0].title,
        html: currentRun.progress.pagesPreview[0].htmlPreview,
        previewImageUrl: currentRun.progress.pagesPreview[0].previewImageUrl,
        capturedAt: new Date().toISOString(),
        consoleEvents: [],
        networkEvents: [],
      }
    : null);
  const showHeroPreview = Boolean(
    currentRun &&
      ["queued", "running", "awaiting_checkpoint"].includes(currentRun.status),
  );

  useEffect(() => {
    if (!previewModalOpen) {
      return;
    }

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = overflow;
    };
  }, [previewModalOpen]);

  useEffect(() => {
    if (currentRun?.status !== "awaiting_checkpoint" || currentRun.progress.checkpoint?.kind !== "login_choice") {
      setLoginDecisionHandled(null);
      return;
    }

    if (loginDecisionHandled === currentRun.runId) {
      return;
    }

    const fallbackAt = currentRun.progress.checkpoint.expiresAt
      ? Math.min(
          new Date(currentRun.progress.checkpoint.expiresAt).getTime(),
          new Date(currentRun.updatedAt).getTime() + runtime.defaultAnalysisOptions.loginDecisionFallbackMs,
        )
      : new Date(currentRun.updatedAt).getTime() + runtime.defaultAnalysisOptions.loginDecisionFallbackMs;

    if (Date.now() >= fallbackAt) {
      setLoginDecisionHandled(currentRun.runId);
      void fetch(`${ANALYSIS_API_BASE_URL}/runs/${currentRun.runId}/checkpoint/continue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "continue_without_login" }),
      }).catch(() => {
        setLoginDecisionHandled(null);
      });
      return;
    }

    const timeout = window.setTimeout(() => {
      setLoginDecisionHandled(currentRun.runId);
      void fetch(`${ANALYSIS_API_BASE_URL}/runs/${currentRun.runId}/checkpoint/continue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action: "continue_without_login" }),
      }).catch(() => {
        setLoginDecisionHandled(null);
      });
    }, fallbackAt - Date.now());

    return () => window.clearTimeout(timeout);
  }, [currentRun, loginDecisionHandled]);

  useEffect(() => {
    if (!currentRun?.error) {
      setDismissedErrorKey(null);
      return;
    }

    const errorKey = `${currentRun.runId}:${currentRun.error}`;
    if (dismissedErrorKey && dismissedErrorKey !== errorKey) {
      setDismissedErrorKey(null);
    }
  }, [currentRun?.error, currentRun?.runId, dismissedErrorKey]);

  const fatalErrorKey = currentRun?.error ? `${currentRun.runId}:${currentRun.error}` : null;
  const showFatalErrorModal =
    currentRun?.status === "failed" &&
    Boolean(currentRun.error) &&
    dismissedErrorKey !== fatalErrorKey;

  return (
    <>
      {showFatalErrorModal && currentRun?.error ? (
        <FatalErrorModal
          run={currentRun}
          onClose={() => setDismissedErrorKey(fatalErrorKey)}
        />
      ) : null}
      {currentRun?.status === "awaiting_checkpoint" && currentRun.progress.checkpoint?.kind === "login_choice" ? (
        <LoginDecisionModal
          run={currentRun}
          loading={loginDecisionHandled === currentRun.runId}
          onChoose={async (action) => {
            setLoginDecisionHandled(currentRun.runId);
            try {
              if (action === "continue_after_login") {
                const response = await fetch(`${ANALYSIS_API_BASE_URL}/runs/${currentRun.runId}/checkpoint/login-run`, {
                  method: "POST",
                });
                const nextRun = (await response.json()) as AnalysisRun & { error?: string };
                if (!response.ok) {
                  throw new Error(nextRun.error ?? "Failed to create login session");
                }
                onReplaceRun(nextRun);
                return;
              }
              await fetch(`${ANALYSIS_API_BASE_URL}/runs/${currentRun.runId}/checkpoint/continue`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ action }),
              });
            } catch {
              setLoginDecisionHandled(null);
            }
          }}
        />
      ) : null}
      <section className="grid gap-4 float-in">
      <div className={`grid gap-2 ${showHeroPreview ? "lg:grid-cols-[minmax(0,1.72fr)_minmax(280px,0.78fr)]" : ""}`}>
        <article className="glass-surface glass-hover flex min-h-[190px] flex-col rounded-[1rem] px-4 py-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.3em] text-cyan-300">Workspace</p>
              <h1 className="mt-0.5 text-[1.22rem] font-semibold leading-none text-white">Run Workspace</h1>
            </div>
            <span className="control-surface rounded-full px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-slate-300">
              Analysis job
            </span>
          </div>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-2.5 py-0.5 text-[10px] text-cyan-100 shadow-[0_10px_24px_rgba(8,145,178,0.12)]">
              {currentRun?.progress.summary ?? "Ready to start"}
            </span>
            {currentRun?.request.targetUrl ? (
              <span className="control-surface inline-flex max-w-full truncate rounded-full px-2.5 py-0.5 text-[10px] text-slate-300">
                {currentRun.request.targetUrl}
              </span>
            ) : null}
          </div>

          <div className="mt-auto pt-3">
            <div className="depth-panel rounded-[0.9rem] p-3">
              <AnalysisForm {...props} />
            </div>
          </div>
        </article>

        {showHeroPreview ? (
          <article className="glass-surface glass-hover flex min-h-[190px] flex-col overflow-hidden rounded-[1rem] p-2">
            <div className="depth-panel flex items-start justify-between gap-2 rounded-[0.8rem] px-3 py-2">
              <div className="min-w-0">
              <p className="text-[11px] uppercase tracking-[0.28em] text-cyan-300">Live preview</p>
              <p className="mt-0.5 truncate text-[10px] text-slate-400">
                  {heroPreview?.title ?? "Current page"}
              </p>
              </div>
              <div className="flex items-center gap-2">
                {heroPreview?.url ? (
                  <span className="control-surface max-w-[9rem] shrink-0 truncate rounded-full px-2.5 py-0.5 text-[10px] text-slate-300">
                    {routeFromUrl(heroPreview.url)}
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => setPreviewModalOpen(true)}
                  className="control-surface tab-motion flex h-8 w-8 items-center justify-center rounded-full text-slate-300"
                  aria-label="Expand live preview"
                  title="Expand live preview"
                >
                  <span className="text-sm leading-none">⤢</span>
                </button>
              </div>
            </div>
            <div className="mt-1.5 min-h-0 flex-1 overflow-hidden rounded-[0.75rem] border border-white/10 bg-slate-950/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              {heroPreview?.previewImageUrl ? (
                <img
                  src={`${API_BASE_URL}${heroPreview.previewImageUrl}`}
                  alt={heroPreview.title}
                  className="h-full w-full object-contain bg-white"
                />
              ) : heroPreview?.html ? (
                <iframe
                  title={heroPreview.title}
                  srcDoc={heroPreview.html}
                  className="h-full w-full bg-white"
                  sandbox="allow-same-origin"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">
                  Preview not available.
                </div>
              )}
            </div>
          </article>
        ) : null}
      </div>

      <RunTracker
        run={currentRun}
        elapsedSeconds={elapsedSeconds}
        remainingSeconds={remainingSeconds}
        onRetryRun={onRetryRun}
      />
    </section>
    {previewModalOpen ? (
      <PreviewModal
        run={currentRun}
        preview={heroPreview}
        pagesFound={currentRun?.progress.pagesDiscovered ?? currentRun?.pages.length ?? 0}
        currentRoute={heroPreview?.url ? routeFromUrl(heroPreview.url) : currentRun?.progress.currentPageUrl ? routeFromUrl(currentRun.progress.currentPageUrl) : "--"}
        onClose={() => setPreviewModalOpen(false)}
      />
    ) : null}
    </>
  );
}

function RunTracker({
  run,
  elapsedSeconds,
  remainingSeconds,
  onRetryRun,
}: {
  run: AnalysisRun | null;
  elapsedSeconds: number;
  remainingSeconds: number | null;
  onRetryRun: (runId: string) => Promise<void>;
}) {
  const [checkpointLoading, setCheckpointLoading] = useState(false);
  const [retryLoading, setRetryLoading] = useState(false);
  const [intelligenceModalOpen, setIntelligenceModalOpen] = useState(false);
  const [leftPaneTab, setLeftPaneTab] = useState<"tree" | "data" | "findings">("tree");
  const [timelineTab, setTimelineTab] = useState<"scopes" | "console" | "network">("scopes");
  const [entriesModalOpen, setEntriesModalOpen] = useState(false);
  const [metricHistory, setMetricHistory] = useState<MetricSnapshot[]>([]);
  const [mobileSectionsOpen, setMobileSectionsOpen] = useState({
    collected: true,
    timeline: false,
  });

  useEffect(() => {
    if (!entriesModalOpen) {
      return;
    }

    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = overflow;
    };
  }, [entriesModalOpen]);

  useEffect(() => {
    setMetricHistory([]);
  }, [run?.runId]);

  useEffect(() => {
    if (!run) {
      setMetricHistory([]);
      return;
    }

    const nextSnapshot: MetricSnapshot = {
      pages: run.progress.pagesDiscovered ?? run.pages.length ?? 0,
      detected: run.progress.interactionsDetected ?? 0,
      tested: run.progress.interactionsTested ?? run.interactions.length ?? 0,
      failures: run.failureClusters.reduce((total, cluster) => total + cluster.occurrences, 0),
      elapsed: elapsedSeconds,
    };

    setMetricHistory((history) => {
      const previous = history.at(-1);
      const sameAsPrevious =
        previous?.pages === nextSnapshot.pages &&
        previous?.detected === nextSnapshot.detected &&
        previous?.tested === nextSnapshot.tested &&
        previous?.failures === nextSnapshot.failures &&
        previous?.elapsed === nextSnapshot.elapsed;

      if (sameAsPrevious) {
        return history;
      }

      return [...history, nextSnapshot].slice(-6);
    });
  }, [
    run,
    run?.failureClusters,
    run?.interactions.length,
    run?.pages.length,
    run?.progress.interactionsDetected,
    run?.progress.interactionsTested,
    run?.progress.pagesDiscovered,
    elapsedSeconds,
  ]);

  if (!run) {
    return (
      <article className="rounded-[1.8rem] border border-white/10 bg-slate-950/82 p-6">
        <p className="text-xs uppercase tracking-[0.28em] text-cyan-300">Live tracking</p>
        <h2 className="mt-3 text-2xl font-semibold text-white">No active run</h2>
      </article>
    );
  }

  const preview = run.progress.liveSession ?? (run.progress.pagesPreview?.[0]
    ? {
        url: run.progress.pagesPreview[0].url,
        title: run.progress.pagesPreview[0].title,
        html: run.progress.pagesPreview[0].htmlPreview,
        previewImageUrl: run.progress.pagesPreview[0].previewImageUrl,
        capturedAt: new Date().toISOString(),
        consoleEvents: [],
        networkEvents: [],
      }
    : null);
  const latestMetrics = metricHistory.at(-1);
  const pagesFound = run.progress.pagesDiscovered ?? latestMetrics?.pages ?? run.pages.length ?? 0;
  const interactionsDetected = run.progress.interactionsDetected ?? latestMetrics?.detected ?? 0;
  const interactionsTested = run.progress.interactionsTested ?? latestMetrics?.tested ?? run.interactions.length ?? 0;
  const failuresFound =
    run.failureClusters.reduce((total, cluster) => total + cluster.occurrences, 0) || latestMetrics?.failures || 0;
  const lastIssue = run.failureClusters.at(-1) ?? run.result?.frontend.failureClusters.at(-1) ?? null;
  const logScopes = Array.from(new Set(run.logs.map((item) => normalizeScope(item.scope))));
  const currentRoute = preview ? routeFromUrl(preview.url) : run.progress.currentPageUrl ? routeFromUrl(run.progress.currentPageUrl) : "--";
  const pageTrend = buildMetricTrend(metricHistory.map((item) => item.pages));
  const testedTrend = buildMetricTrend(metricHistory.map((item) => item.tested));
  const failureTrend = buildMetricTrend(metricHistory.map((item) => item.failures));
  const timeTrend = buildMetricTrend(metricHistory.map((item) => item.elapsed));
  const intelligence = buildRunIntelligence(run, {
    pagesFound,
    interactionsDetected,
    interactionsTested,
    failuresFound,
    currentRoute,
  });
  const summaryStrip = buildRunSummaryStrip(run, {
    pagesFound,
    interactionsDetected,
    interactionsTested,
    failuresFound,
  });

  const continueCheckpoint = async (action: "continue_without_login" | "continue_after_login" = "continue_after_login") => {
    try {
      setCheckpointLoading(true);
      await fetch(`${ANALYSIS_API_BASE_URL}/runs/${run.runId}/checkpoint/continue`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action }),
      });
    } finally {
      setCheckpointLoading(false);
    }
  };

  const retryAnalysis = async () => {
    try {
      setRetryLoading(true);
      await onRetryRun(run.runId);
    } finally {
      setRetryLoading(false);
    }
  };

  const toggleMobileSection = (key: "collected" | "timeline") => {
    setMobileSectionsOpen((current) => ({
      ...current,
      [key]: !current[key],
    }));
  };

  return (
      <article className="glass-surface grid gap-4 rounded-[1.8rem] p-4 sm:p-6">
      <div className="glass-surface sticky top-4 z-20 rounded-[1rem] px-3 py-2.5">
        <div className="grid gap-2.5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-1.5">
            <StickyChip label="Run status" value={humanizeRunStatus(run)} tone="cyan" />
            <StickyChip label="Current page" value={currentRoute} tone="slate" />
            {run.progress.checkpoint?.kind === "login_choice" && run.progress.checkpoint.loginUrl ? (
              <StickyChip label="Login page" value={routeFromUrl(run.progress.checkpoint.loginUrl)} tone="emerald" />
            ) : null}
            {lastIssue ? <StickyChip label="Latest issue" value={lastIssue.title} tone="rose" /> : null}
            <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-xs text-cyan-200">
              {humanizeRunStatus(run)}
            </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {run.status === "failed" ? (
                <button
                  type="button"
                  onClick={retryAnalysis}
                  disabled={retryLoading}
                  className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-3 py-1.5 text-[11px] text-cyan-200"
                >
                  {retryLoading ? "Retrying..." : "Retry from failure"}
                </button>
              ) : null}
              {run.status === "awaiting_checkpoint" ? (
                <div className="flex flex-wrap items-center gap-2">
                  {run.progress.checkpoint?.allowedActions?.includes("continue_without_login") ? (
                    <button
                      type="button"
                      onClick={() => continueCheckpoint("continue_without_login")}
                      disabled={checkpointLoading}
                      className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-[11px] text-slate-200"
                    >
                      {checkpointLoading ? "Resuming..." : "Continue without login"}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => continueCheckpoint("continue_after_login")}
                    disabled={checkpointLoading}
                    className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-3 py-1.5 text-[11px] text-cyan-200"
                  >
                    {checkpointLoading
                      ? "Resuming..."
                      : run.progress.checkpoint?.kind === "login_choice"
                        ? "I completed login"
                        : "Continue checkpoint"}
                  </button>
                </div>
              ) : null}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIntelligenceModalOpen(true)}
                  className="rounded-full border border-cyan-300/25 bg-cyan-400/10 px-3 py-1.5 text-[11px] text-cyan-100"
                >
                  Summarize run
                </button>
              </div>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-4">
            <RuntimeGraphCard
              label="Pages scanned"
              value={`${pagesFound} ${pagesFound === 1 ? "page" : "pages"}`}
              accent="cyan"
              points={pageTrend}
              hint="Pages the run reached during this scan."
            />
            <RuntimeGraphCard
              label="Interactions checked"
              value={interactionsDetected > 0 ? `${interactionsTested} of ${interactionsDetected}` : String(interactionsTested)}
              accent="emerald"
              points={testedTrend}
              hint="Checks completed on buttons, links, forms, or other interactive elements."
            />
            <RuntimeGraphCard
              label="Issues found"
              value={failuresFound === 0 ? "No issues" : `${failuresFound} issue${failuresFound === 1 ? "" : "s"}`}
              accent="rose"
              points={failureTrend}
              hint="Repeated problems or grouped failures found during the run."
            />
            <RuntimeGraphCard
              label="Run duration"
              value={`${formatReadableDuration(elapsedSeconds)}${remainingSeconds === null ? "" : ` · ${formatReadableDuration(remainingSeconds)} left`}`}
              accent="amber"
              points={timeTrend}
              hint="How long the run has taken, plus time left when an estimate is available."
            />
          </div>
        </div>
      </div>

      <section className="grid gap-3 lg:grid-cols-2 xl:grid-cols-4">
        <PlainSummaryCard title="Result" text={summaryStrip.result} />
        <PlainSummaryCard title="Coverage" text={summaryStrip.coverage} />
        <PlainSummaryCard title="Important note" text={summaryStrip.limitation} />
        <PlainSummaryCard title="What it means" text={summaryStrip.impact} />
      </section>

      <div className="hidden xl:block">
        <div className="grid min-h-[680px] gap-2.5 xl:grid-cols-[minmax(360px,1.18fr)_minmax(340px,0.92fr)]">
            <div className="glass-surface h-[540px] min-w-0 overflow-hidden rounded-[1.15rem] p-3">
              <CollectedPane run={run} leftPaneTab={leftPaneTab} />
            </div>

            <div className="glass-surface h-[540px] min-w-0 overflow-hidden rounded-[1.15rem] p-3">
              <TimelinePane
                run={run}
                logScopes={logScopes}
                timelineTab={timelineTab}
                onTimelineTabChange={setTimelineTab}
                onEntriesModalOpenChange={setEntriesModalOpen}
              />
            </div>
        </div>
      </div>

      <div className="grid gap-3 xl:hidden">
          <MobileAccordionSection
            title="Captured data"
            description="Pages, paths, and page details"
            open={mobileSectionsOpen.collected}
            onToggle={() => toggleMobileSection("collected")}
            headerCenterContent={
              <div className="inline-flex min-w-max rounded-full border border-white/10 bg-slate-950/70 p-1">
                {[
                  ["tree", "Tree"],
                  ["data", "Data"],
                  ["findings", "Findings"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setLeftPaneTab(key as "tree" | "data" | "findings");
                    }}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] transition ${
                      leftPaneTab === key
                        ? "bg-cyan-400/12 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(103,232,249,0.25)]"
                        : "text-slate-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
          >
            <CollectedPane run={run} leftPaneTab={leftPaneTab} />
          </MobileAccordionSection>
        <MobileAccordionSection
            title="Activity logs"
            description="What the system is doing"
            open={mobileSectionsOpen.timeline}
            onToggle={() => toggleMobileSection("timeline")}
            headerCenterContent={
              <div className="inline-flex min-w-max rounded-full border border-white/10 bg-slate-950/70 p-1">
                {[
                  ["scopes", "Scopes"],
                  ["console", "Console"],
                  ["network", "Network"],
                ].map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      setTimelineTab(key as "scopes" | "console" | "network");
                    }}
                    className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] transition ${
                      timelineTab === key
                        ? "bg-cyan-400/12 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(103,232,249,0.25)]"
                        : "text-slate-300"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            }
            headerRightContent={
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  setEntriesModalOpen(true);
                }}
                className="control-surface tab-motion flex h-8 w-8 items-center justify-center rounded-full text-slate-300"
                aria-label="Open all log entries"
                title="Open all entries"
              >
                <span className="text-sm leading-none">⤢</span>
              </button>
            }
          >
          <TimelinePane
            run={run}
            logScopes={logScopes}
            timelineTab={timelineTab}
            onTimelineTabChange={setTimelineTab}
            onEntriesModalOpenChange={setEntriesModalOpen}
            hideHeader
          />
        </MobileAccordionSection>
      </div>

      {run.progress.checkpoint ? (
        <div className="rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
          <p>{run.progress.checkpoint.instructions}</p>
          {run.progress.checkpoint.loginUrl ? (
            <p className="mt-2 break-all text-xs text-emerald-100/90">Login URL: {run.progress.checkpoint.loginUrl}</p>
          ) : null}
        </div>
      ) : null}

      {run.error ? (
        <div className="rounded-2xl border border-rose-300/20 bg-rose-400/10 px-4 py-3 text-sm text-rose-200">
          {run.error}
        </div>
      ) : null}
      {entriesModalOpen ? (
        <EntriesModal
          timelineTab={timelineTab}
          groupedLogs={logScopes
            .map((scope) => ({
              scope,
              items: run.logs.filter((item) => normalizeScope(item.scope) === scope).slice(-6).reverse(),
            }))
            .sort((a, b) => {
              const scopePriority = ["queue", "crawl", "retry", "crawler", "api", "assertions", "accessibility", "visual", "auth"];
              const aIndex = scopePriority.indexOf(a.scope);
              const bIndex = scopePriority.indexOf(b.scope);
              const aRank = aIndex === -1 ? scopePriority.length : aIndex;
              const bRank = bIndex === -1 ? scopePriority.length : bIndex;
              return aRank - bRank || a.scope.localeCompare(b.scope);
            })}
          consoleItems={run.progress.liveSession?.consoleEvents ?? []}
          networkItems={run.progress.liveSession?.networkEvents ?? []}
          onClose={() => setEntriesModalOpen(false)}
        />
      ) : null}
      {intelligenceModalOpen ? (
        <RunIntelligenceModal
          intelligence={intelligence}
          onClose={() => setIntelligenceModalOpen(false)}
        />
      ) : null}
    </article>
  );
}

function CollectedPane({
  run,
  leftPaneTab,
}: {
  run: AnalysisRun;
  leftPaneTab: "tree" | "data" | "findings";
}) {
  const crawlTreeItems =
    run.pages.length > 0
      ? run.pages
      : (run.progress.pagesPreview ?? []).map((pagePreview, index) => ({
          url: pagePreview.url,
          title: pagePreview.title,
          routePath: pagePreview.routePath,
          depth: Math.min(index, 4),
        }));
  const activePage = run.progress.pagesPreview?.[0];
  const findings = [...run.failureClusters, ...(run.result?.frontend.failureClusters ?? [])]
    .filter((item, index, items) => items.findIndex((candidate) => candidate.clusterId === item.clusterId) === index)
    .slice(0, 8);

      return (
        <div className="grid h-full min-h-0 gap-2">
          <div className="grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="rounded-[0.9rem] border border-white/10 bg-slate-950/60 p-2.5">
            <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-300">Run status</p>
            <p className="mt-1 text-[13px] font-semibold text-white">{humanizeStageTitle(run)}</p>
            <p className="mt-1 text-[12px] text-slate-300">{humanizeStageSummary(run)}</p>
            <p className="mt-1 line-clamp-2 text-[10px] text-slate-500">{humanizeStageTechnical(run)}</p>
          </div>

          <div className={`rounded-[0.9rem] border p-2.5 ${run.progress.lastSuccessfulAction ? "border-emerald-300/20 bg-emerald-400/10" : "border-white/10 bg-slate-950/60"}`}>
            <p className={`text-[11px] uppercase tracking-[0.22em] ${run.progress.lastSuccessfulAction ? "text-emerald-200" : "text-slate-400"}`}>Last finished step</p>
            <p className="mt-1 text-[13px] text-slate-100">{humanizeLastAction(run.progress.lastSuccessfulAction?.label)}</p>
            <p className="mt-1 line-clamp-2 text-[10px] text-slate-400">
              {run.progress.lastSuccessfulAction?.pageUrl
                ? `Page: ${routeFromUrl(run.progress.lastSuccessfulAction.pageUrl)}`
                : "No completed step has been recorded yet."}
            </p>
          </div>
        </div>

        {leftPaneTab === "tree" ? (
          <div className="min-h-0 overflow-y-auto rounded-[0.9rem] border border-white/10 bg-[linear-gradient(180deg,rgba(2,6,23,0.76)_0%,rgba(15,23,42,0.82)_100%)] p-2.5">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-300">Pages visited</p>
                <p className="mt-0.5 text-[10px] text-slate-500">This shows the pages the run reached.</p>
              </div>
              <span className="rounded-full border border-cyan-300/15 bg-cyan-400/10 px-2.5 py-0.5 text-[10px] text-cyan-100">
                {crawlTreeItems.length} {crawlTreeItems.length === 1 ? "page" : "pages"}
              </span>
            </div>
            <div className="mt-2 grid gap-1.5">
              {crawlTreeItems.slice(0, 18).map((page, index) => {
                const isCurrent =
                  activePage?.url === page.url ||
                  run.progress.currentPageUrl === page.url ||
                  routeFromUrl(run.progress.currentPageUrl ?? "") === page.routePath;
                const hasNextSiblingDepth =
                  index < crawlTreeItems.length - 1 &&
                  Math.max(crawlTreeItems[index + 1]?.depth ?? 0, 0) >= Math.max(page.depth, 0);

                return (
                  <div
                    key={page.url}
                    className={`relative overflow-hidden rounded-[0.9rem] border px-2.5 py-2 transition ${
                      isCurrent
                        ? "border-cyan-300/25 bg-cyan-400/10 shadow-[0_0_0_1px_rgba(103,232,249,0.08)]"
                        : "border-white/10 bg-white/[0.04]"
                    }`}
                    style={{ marginLeft: `${Math.max(page.depth, 0) * 10}px` }}
                  >
                    {page.depth > 0 ? (
                      <div
                        className="absolute bottom-0 left-0 top-0 border-l border-dashed border-cyan-400/15"
                        style={{ left: `${Math.max(page.depth, 0) * 10 - 6}px` }}
                      />
                    ) : null}
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5 flex shrink-0 items-center gap-1.5">
                        <span className={`h-2.5 w-2.5 rounded-full ${isCurrent ? "bg-cyan-300 shadow-[0_0_12px_rgba(103,232,249,0.55)]" : "bg-slate-500"}`} />
                        <span className={`h-px w-3 ${hasNextSiblingDepth ? "bg-cyan-400/25" : "bg-white/10"}`} />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-2">
                          <p className={`truncate text-[12px] ${isCurrent ? "font-medium text-white" : "text-slate-100"}`}>
                            {friendlyPageName(page.title, page.url)}
                          </p>
                          <span className="shrink-0 rounded-full border border-white/10 bg-slate-950/55 px-2 py-0.5 text-[9px] uppercase tracking-[0.16em] text-slate-400">
                            d{Math.max(page.depth, 0)}
                          </span>
                        </div>
                        <p className={`mt-0.5 truncate text-[10px] ${isCurrent ? "text-cyan-200" : "text-slate-400"}`}>
                          {page.routePath}
                        </p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ) : null}

        {leftPaneTab === "data" ? (
          <div className="grid min-h-0 gap-2 overflow-y-auto pr-1">
            {activePage ? (
              <div className="rounded-[0.9rem] border border-white/10 bg-slate-950/60 p-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold text-white">{activePage.title}</p>
                    <p className="mt-1 truncate text-[11px] text-cyan-300">{activePage.routePath}</p>
                  </div>
                  <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[11px] text-slate-300">
                    {activePage.interactiveCount}
                  </span>
                </div>
                <div className="mt-2 grid gap-1.5">
                  <CompactList title="Headings" items={activePage.headings} />
                  <CompactList title="Buttons" items={activePage.buttons} />
                  <CompactList title="Links" items={activePage.links} />
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-400">No collected data yet.</p>
          )}
        </div>
      ) : null}

        {leftPaneTab === "findings" ? (
          <div className="grid min-h-0 gap-2 overflow-y-auto pr-1">
            {findings.length > 0 ? findings.map((item) => (
              <div key={item.clusterId} className="rounded-[0.9rem] border border-rose-300/15 bg-[linear-gradient(135deg,rgba(63,28,45,0.42)_0%,rgba(15,23,42,0.82)_100%)] p-2.5">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-[12px] font-semibold text-white">{item.title}</p>
                  <span className="rounded-full border border-rose-300/20 bg-rose-400/10 px-2.5 py-0.5 text-[11px] text-rose-200">
                    {item.occurrences}
                  </span>
                </div>
                <p className="mt-1 text-[10px] text-slate-300">{item.summary}</p>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {item.pages.slice(0, 3).map((page) => (
                    <span key={page} className="rounded-full border border-white/10 bg-slate-950/55 px-2.5 py-0.5 text-[10px] text-slate-300">
                      {routeFromUrl(page)}
                    </span>
                  ))}
              </div>
            </div>
          )) : (
            <p className="text-sm text-slate-400">No findings yet.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}

function PreviewPane({
  run,
  preview,
  pagesFound,
  currentRoute,
  layout = "stack",
}: {
  run: AnalysisRun | null;
  preview:
    | {
        url: string;
        title: string;
        html?: string;
        previewImageUrl?: string;
        capturedAt: string;
        consoleEvents: string[];
        networkEvents: string[];
      }
    | null;
  pagesFound: number;
  currentRoute: string;
  layout?: "stack" | "row";
}) {
  const [previewMode, setPreviewMode] = useState<"visual" | "html">(
    preview?.previewImageUrl ? "visual" : "html",
  );

  useEffect(() => {
    setPreviewMode(preview?.previewImageUrl ? "visual" : "html");
  }, [preview?.previewImageUrl, preview?.url]);

  const canShowVisual = Boolean(preview?.previewImageUrl);
  const canShowHtml = Boolean(preview?.html);
  const rowLayout = layout === "row";
  const pageDetails = preview?.url && run
    ? (run.result?.frontend.pages ?? run.pages).find((page) => page.url === preview.url) ?? null
    : null;
  const pageInteractions = preview?.url && run
    ? run.interactions.filter((item) => item.pageUrl === preview.url)
    : [];
  const pageFindings = preview?.url && run?.result
    ? run.result.frontend.runtimeFindings.filter((finding) => finding.pageUrl === preview.url)
    : [];
  const pageSummary = buildPreviewPageSummary({
    run,
    preview,
    pageDetails,
    pageInteractions,
    pageFindings,
    pagesFound,
    currentRoute,
  });

  return (
    <div className={`grid h-full min-h-0 gap-3 ${rowLayout ? "lg:grid-cols-[340px_minmax(0,1fr)]" : ""}`}>
      <div className={`rounded-2xl border border-white/10 bg-slate-950/60 p-3 ${rowLayout ? "flex min-h-0 flex-col justify-between" : ""}`}>
        <div className={`flex gap-3 ${rowLayout ? "min-h-0 flex-1 flex-col" : "flex-col"}`}>
          <div className={`${rowLayout ? "app-scrollbar min-h-0 flex-1 overflow-y-auto pr-1" : ""}`}>
          <div className="min-w-0">
            <p className="text-xs uppercase tracking-[0.25em] text-cyan-300">Current page summary</p>
            <p className="mt-1.5 text-sm font-semibold text-white">{pageSummary.pageType}</p>
            <p className="mt-1 text-sm leading-6 text-slate-300">{pageSummary.whyItMatters}</p>
          </div>

          <div className="flex flex-wrap gap-2">
            <span className={`rounded-full border px-3 py-1 text-[11px] ${pageSummary.resultTone}`}>
              {pageSummary.result}
            </span>
            {preview ? (
              <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-slate-300">
                Captured at {new Date(preview.capturedAt).toLocaleTimeString()}
              </span>
            ) : null}
            <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-slate-300">
              {pagesFound} pages scanned so far
            </span>
            <span className="max-w-full truncate rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] text-slate-300">
              Route: {currentRoute}
            </span>
          </div>

          <PreviewInsightSection title="Why this page matters" items={pageSummary.whyItems} />
          <PreviewInsightSection title="What was checked" items={pageSummary.checkedItems} />
          <PreviewInsightSection title="What we noticed" items={pageSummary.noticedItems} />
          </div>

          {(canShowVisual || canShowHtml) ? (
            <div className="mt-auto flex gap-2 pt-1">
              {canShowVisual ? (
                <button
                  type="button"
                  onClick={() => setPreviewMode("visual")}
                  className={`rounded-full border px-3 py-1 text-[11px] ${
                    previewMode === "visual"
                      ? "border-cyan-300/25 bg-cyan-400/10 text-cyan-100"
                      : "border-white/10 bg-white/5 text-slate-300"
                  }`}
                >
                  Screenshot
                </button>
              ) : null}
              {canShowHtml ? (
                <button
                  type="button"
                  onClick={() => setPreviewMode("html")}
                  className={`rounded-full border px-3 py-1 text-[11px] ${
                    previewMode === "html"
                      ? "border-cyan-300/25 bg-cyan-400/10 text-cyan-100"
                      : "border-white/10 bg-white/5 text-slate-300"
                  }`}
                >
                  Page source
                </button>
              ) : null}
            </div>
          ) : null}
          {preview ? (
            <p className="break-all text-xs leading-5 text-cyan-300">{preview.url}</p>
          ) : null}
        </div>
      </div>

      <div className={`min-h-0 overflow-hidden rounded-2xl border border-white/10 bg-slate-950/60 ${rowLayout ? "" : "flex-1"}`}>
        {preview ? (
          previewMode === "html" && canShowHtml ? (
            <iframe
              title={preview.title}
              srcDoc={preview.html}
              className="h-full w-full bg-white"
              sandbox="allow-same-origin"
            />
          ) : canShowVisual ? (
            <img
              src={`${API_BASE_URL}${preview.previewImageUrl}`}
              alt={preview.title}
              className="h-full w-full object-contain bg-white"
            />
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-slate-500">
              Preview not available.
            </div>
          )
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            Preview not available.
          </div>
        )}
      </div>
    </div>
  );
}

function PreviewModal({
  run,
  preview,
  pagesFound,
  currentRoute,
  onClose,
}: {
  run: AnalysisRun | null;
  preview:
    | {
        url: string;
        title: string;
        html?: string;
        previewImageUrl?: string;
        capturedAt: string;
        consoleEvents: string[];
        networkEvents: string[];
      }
    | null;
  pagesFound: number;
  currentRoute: string;
  onClose: () => void;
}) {
  const modal = (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/82 px-3 py-3 sm:px-4 sm:py-4 backdrop-blur-md">
      <div className="glass-surface flex h-[min(84vh,760px)] w-full max-w-[min(96vw,1200px)] flex-col overflow-hidden rounded-[1.35rem] p-3 sm:h-[min(86vh,800px)] sm:p-4">
        <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-2.5">
          <div>
            <p className="text-sm font-medium text-white">Live preview</p>
            <p className="mt-1 text-xs text-slate-400">Current page view</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="control-surface tab-motion rounded-full px-3 py-1.5 text-xs text-slate-300"
          >
            Close
          </button>
        </div>

        <div className="mt-3 min-h-0 flex-1">
          <PreviewPane run={run} preview={preview} pagesFound={pagesFound} currentRoute={currentRoute} layout="row" />
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function EntriesModal({
  timelineTab,
  groupedLogs,
  consoleItems,
  networkItems,
  onClose,
}: {
  timelineTab: "scopes" | "console" | "network";
  groupedLogs: Array<{
    scope: string;
    items: Array<{
      timestamp: string;
      message: string;
      level: "info" | "warn" | "error";
    }>;
  }>;
  consoleItems: string[];
  networkItems: string[];
  onClose: () => void;
}) {
  const totalEntries =
    timelineTab === "scopes"
      ? groupedLogs.reduce((total, group) => total + group.items.length, 0)
      : timelineTab === "console"
        ? consoleItems.length
        : networkItems.length;

  const modal = (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-slate-950/76 px-4 py-6 backdrop-blur-md">
      <div className="glass-surface flex h-[min(82vh,760px)] w-full max-w-5xl flex-col overflow-hidden rounded-[1.4rem] p-4">
          <div className="flex items-center justify-between gap-3 border-b border-white/10 pb-3">
            <div>
              <p className="text-[11px] uppercase tracking-[0.24em] text-cyan-300">
                {timelineTab === "scopes" ? "All scope entries" : timelineTab === "console" ? "All console entries" : "All network entries"}
              </p>
              <p className="mt-1 text-sm text-slate-300">{totalEntries} total entries</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="control-surface tab-motion rounded-full px-3 py-1.5 text-xs text-slate-300"
            >
              Close
            </button>
          </div>

          <div className="app-scrollbar mt-3 min-h-0 flex-1 overflow-y-auto pr-1">
            {timelineTab === "scopes" ? (
              <div className="grid gap-3 lg:grid-cols-2">
                {groupedLogs.map((group) => (
                  <div key={`modal-${group.scope}`} className="flex min-h-[220px] flex-col overflow-hidden rounded-[1rem] border border-white/10 bg-slate-950/55">
                    <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2.5">
                      <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-cyan-200">
                        {group.scope}
                      </span>
                      <span className="text-[11px] text-slate-500">{group.items.length} events</span>
                    </div>
                    <div className="app-scrollbar grid min-h-0 flex-1 gap-2 overflow-y-auto px-3 py-2.5">
                      {group.items.map((item) => (
                        <div key={`modal-${item.timestamp}-${item.message}`} className="flex gap-3 rounded-[0.9rem] border border-white/10 bg-white/5 px-3 py-2.5">
                          <div className={`mt-1 h-2.5 w-2.5 rounded-full ${toneForLevel(item.level)}`} />
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-[11px] text-slate-500">{new Date(item.timestamp).toLocaleTimeString()}</span>
                              <span className="text-[11px] uppercase text-slate-400">{item.level}</span>
                            </div>
                            <p className="mt-1 break-words text-[12px] text-slate-200">{item.message}</p>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <CompactLogList
                title={timelineTab === "console" ? "Console" : "Network"}
                items={timelineTab === "console" ? consoleItems : networkItems}
                showAll
              />
            )}
          </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function PreviewInsightSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="rounded-[0.95rem] border border-white/10 bg-white/5 p-4">
      <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">{title}</p>
      <div className="mt-3 grid gap-3">
        {items.map((item, index) => (
          <div key={`${title}-${index}-${item}`} className="rounded-[0.8rem] border border-white/10 bg-slate-950/55 px-4 py-3 text-xs leading-6 text-slate-300">
            {item}
          </div>
        ))}
      </div>
    </section>
  );
}

function RunIntelligenceModal({
  intelligence,
  onClose,
}: {
  intelligence: RunIntelligence;
  onClose: () => void;
}) {
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  const modal = (
    <div className="fixed inset-0 z-[125] flex items-center justify-center bg-slate-950/84 px-3 py-4 sm:px-4 sm:py-6 backdrop-blur-md">
      <div className="glass-surface flex w-full max-w-[min(94vw,68rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden rounded-[1.35rem] p-4 shadow-[0_24px_80px_rgba(2,6,23,0.65)] sm:max-h-[calc(100vh-3rem)] sm:p-5">
        <div className="flex items-start justify-between gap-4 border-b border-white/10 pb-4">
          <div className="min-w-0">
            <p className="text-[11px] uppercase tracking-[0.28em] text-cyan-300">Run intelligence</p>
            <h2 className="mt-2 text-xl font-semibold text-white sm:text-2xl">What this run means for the website</h2>
            <p className="mt-2 max-w-[48rem] text-sm leading-6 text-slate-300">{intelligence.overview}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200"
          >
            Close
          </button>
        </div>

        <div className="app-scrollbar mt-4 grid min-h-0 flex-1 gap-4 overflow-y-auto pr-1 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
          <div className="grid gap-4">
            <IntelligenceSection title="What this run did" items={intelligence.did} />
            <IntelligenceSection title="What was in scope" items={intelligence.scope} />
            <IntelligenceSection title="Website insights" items={intelligence.websiteInsights} />
          </div>

          <div className="grid gap-4">
            <ConfidenceCard
              level={intelligence.confidence.level}
              summary={intelligence.confidence.summary}
              reasons={intelligence.confidence.reasons}
            />
            <IntelligenceSection title="Risks and limitations" items={intelligence.limitations} />
            <IntelligenceSection title="Recommended next steps" items={intelligence.nextSteps} />
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function TimelinePane({
  run,
  logScopes,
  timelineTab,
  onTimelineTabChange,
  onEntriesModalOpenChange,
  hideHeader = false,
}: {
  run: AnalysisRun;
  logScopes: string[];
  timelineTab: "scopes" | "console" | "network";
  onTimelineTabChange: (tab: "scopes" | "console" | "network") => void;
  onEntriesModalOpenChange: (open: boolean) => void;
  hideHeader?: boolean;
}) {
  const liveSession = run.progress.liveSession;
  const scopePriority = ["queue", "crawl", "retry", "crawler", "api", "assertions", "accessibility", "visual", "auth"];
  const groupedLogs = logScopes
    .map((scope) => ({
      scope,
      items: run.logs.filter((item) => normalizeScope(item.scope) === scope).slice(-6).reverse(),
    }))
      .sort((a, b) => {
        const aIndex = scopePriority.indexOf(a.scope);
        const bIndex = scopePriority.indexOf(b.scope);
        const aRank = aIndex === -1 ? scopePriority.length : aIndex;
        const bRank = bIndex === -1 ? scopePriority.length : bIndex;
        return aRank - bRank || a.scope.localeCompare(b.scope);
      });
  return (
    <div className="grid h-full min-h-0 gap-3">
        {!hideHeader ? (
          <div className="grid items-center gap-3 border-b border-white/10 pb-3 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
            <div />

            <div className="justify-self-center overflow-x-auto pb-1">
              <div className="inline-flex min-w-max rounded-full border border-white/10 bg-slate-950/70 p-1">
              {[
                ["scopes", "Simple view"],
                ["console", "Console"],
                ["network", "Network"],
              ].map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => onTimelineTabChange(key as "scopes" | "console" | "network")}
                  className={`shrink-0 rounded-full px-3 py-1.5 text-[11px] transition ${
                    timelineTab === key
                      ? "bg-cyan-400/12 text-cyan-100 shadow-[inset_0_0_0_1px_rgba(103,232,249,0.25)]"
                      : "text-slate-300"
                  }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="justify-self-end">
              <button
                type="button"
                onClick={() => onEntriesModalOpenChange(true)}
                className="control-surface tab-motion flex h-8 w-8 items-center justify-center rounded-full text-slate-300"
                aria-label="Open all log entries"
                title="Open all entries"
              >
                <span className="text-sm leading-none">⤢</span>
              </button>
            </div>
          </div>
        ) : null}

        {timelineTab === "scopes" ? (
          <div className="app-scrollbar grid min-h-0 gap-2 overflow-y-auto pr-1 lg:grid-cols-2 2xl:grid-cols-3">
            {groupedLogs.length > 0 ? groupedLogs.map((group) => {
              return (
                <div key={group.scope} className="flex min-h-[180px] max-h-[220px] flex-col overflow-hidden rounded-[1rem] border border-white/10 bg-slate-950/60">
                  <div className="flex items-center justify-between gap-3 px-3 py-2.5">
                    <div className="flex items-center gap-3">
                      <span className="rounded-full border border-cyan-300/20 bg-cyan-400/10 px-3 py-1 text-[11px] uppercase tracking-[0.2em] text-cyan-200">
                        {friendlyScopeLabel(group.scope)}
                      </span>
                      <span className="text-[11px] text-slate-500">{group.items.length} events</span>
                    </div>
                  </div>
                  <div className="app-scrollbar grid min-h-0 flex-1 gap-2 overflow-y-auto border-t border-white/10 px-3 py-2.5">
                    {group.items.map((item) => (
                      <div key={`${item.timestamp}-${item.message}`} className="flex gap-3 rounded-[0.9rem] border border-white/10 bg-white/5 px-3 py-2.5">
                        <div className={`mt-1 h-2.5 w-2.5 rounded-full ${toneForLevel(item.level)}`} />
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-[11px] text-slate-500">{new Date(item.timestamp).toLocaleTimeString()}</span>
                            <span className="text-[11px] uppercase text-slate-400">{item.level}</span>
                          </div>
                          <p className="mt-1 break-words text-[12px] text-slate-200">{humanizeLogMessage(item.message)}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            }) : (
            <div className="rounded-2xl border border-white/10 bg-slate-950/60 px-4 py-3 text-xs text-slate-500">
              No logs yet.
            </div>
          )}
        </div>
        ) : (
          <div className="app-scrollbar grid min-h-0 gap-3 overflow-y-auto pr-1">
            <CompactLogList
              title={timelineTab === "console" ? "Console" : "Network"}
              items={timelineTab === "console" ? (liveSession?.consoleEvents ?? []) : (liveSession?.networkEvents ?? [])}
          />
        </div>
      )}

    </div>
  );
}

function MobileAccordionSection({
  title,
  description,
  open,
  onToggle,
  headerCenterContent,
  headerRightContent,
  children,
}: {
  title: string;
  description: string;
  open: boolean;
  onToggle: () => void;
  headerCenterContent?: React.ReactNode;
  headerRightContent?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/10 bg-slate-900/60">
      <div className="grid items-center gap-3 px-4 py-4 lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <button
          type="button"
          onClick={onToggle}
          className="text-left"
        >
          <p className="text-sm font-medium text-white">{title}</p>
          <p className="mt-1 text-xs text-slate-400">{description}</p>
        </button>
        {headerCenterContent ? (
          <div className="justify-self-center overflow-x-auto">{headerCenterContent}</div>
        ) : null}
        <div className="flex items-center justify-self-end gap-2">
          <button
            type="button"
            onClick={onToggle}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-slate-300"
          >
            {open ? "Hide" : "Show"}
          </button>
          {headerRightContent}
        </div>
      </div>
      {open ? <div className="border-t border-white/10 p-4 fade-in-up">{children}</div> : null}
    </section>
  );
}

function RuntimeGraphCard({
  label,
  value,
  accent,
  points,
  hint,
}: {
  label: string;
  value: string;
  accent: "cyan" | "emerald" | "rose" | "amber";
  points: string;
  hint: string;
}) {
  const toneClass =
    accent === "emerald"
      ? "border-emerald-300/15 bg-emerald-400/8 text-emerald-200"
      : accent === "rose"
        ? "border-rose-300/15 bg-rose-400/8 text-rose-200"
        : accent === "amber"
          ? "border-amber-300/15 bg-amber-400/8 text-amber-200"
          : "border-cyan-300/15 bg-cyan-400/8 text-cyan-200";

  return (
    <div className={`rounded-xl border px-3 py-2 ${toneClass}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] uppercase tracking-[0.18em]">{label}</p>
        <p className="text-sm font-semibold text-white">{value}</p>
      </div>
      <svg viewBox="0 0 100 24" className="mt-1.5 h-6 w-full">
        <polyline
          fill="none"
          stroke={
            accent === "rose"
              ? "#fda4af"
              : accent === "amber"
                ? "#fcd34d"
                : accent === "emerald"
                  ? "#6ee7b7"
                  : "#67e8f9"
          }
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          points={points}
        />
      </svg>
      <p className="mt-1 text-[11px] leading-5 text-slate-400">{hint}</p>
    </div>
  );
}

function PlainSummaryCard({ title, text }: { title: string; text: string }) {
  return (
    <section className="rounded-[1rem] border border-white/10 bg-slate-950/60 p-4">
      <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-300">{title}</p>
      <p className="mt-2 text-sm leading-6 text-slate-300">{text}</p>
    </section>
  );
}

function IntelligenceSection({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="rounded-[1rem] border border-white/10 bg-slate-950/60 p-4">
      <p className="text-[11px] uppercase tracking-[0.22em] text-cyan-300">{title}</p>
      <div className="mt-3 grid gap-2">
        {items.map((item, index) => (
          <div key={`${title}-${index}-${item}`} className="rounded-[0.9rem] border border-white/10 bg-white/5 px-3 py-2.5 text-sm leading-6 text-slate-300">
            {item}
          </div>
        ))}
      </div>
    </section>
  );
}

function ConfidenceCard({
  level,
  summary,
  reasons,
}: {
  level: "High" | "Medium" | "Low";
  summary: string;
  reasons: string[];
}) {
  const tone =
    level === "High"
      ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-100"
      : level === "Low"
        ? "border-rose-300/20 bg-rose-400/10 text-rose-100"
        : "border-amber-300/20 bg-amber-400/10 text-amber-100";

  return (
    <section className={`rounded-[1rem] border p-4 ${tone}`}>
      <p className="text-[11px] uppercase tracking-[0.22em]">Confidence</p>
      <div className="mt-3 flex items-center gap-3">
        <span className="rounded-full border border-white/10 bg-white/10 px-3 py-1 text-sm font-semibold text-white">{level}</span>
        <p className="text-sm leading-6 text-white">{summary}</p>
      </div>
      <div className="mt-3 grid gap-2">
        {reasons.map((reason, index) => (
          <div key={`${level}-${index}-${reason}`} className="rounded-[0.9rem] border border-white/10 bg-black/10 px-3 py-2 text-sm leading-6 text-white/90">
            {reason}
          </div>
        ))}
      </div>
    </section>
  );
}

function StickyChip({ label, value, tone }: { label: string; value: string; tone: "cyan" | "emerald" | "rose" | "slate" }) {
  const toneClass =
    tone === "emerald"
      ? "border-emerald-300/20 bg-emerald-400/10 text-emerald-200"
      : tone === "rose"
        ? "border-rose-300/20 bg-rose-400/10 text-rose-200"
        : tone === "slate"
          ? "border-white/10 bg-white/5 text-slate-300"
          : "border-cyan-300/20 bg-cyan-400/10 text-cyan-200";

  return (
    <div className={`rounded-full border px-2.5 py-1 ${toneClass}`}>
      <span className="text-[10px] uppercase tracking-[0.18em]">{label}</span>
      <span className="ml-1.5 text-[11px]">{value}</span>
    </div>
  );
}

function CompactList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="rounded-[0.85rem] border border-white/10 bg-slate-900/55 p-2.5">
      <p className="text-[10px] uppercase tracking-[0.2em] text-slate-400">{title}</p>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {items.length > 0 ? items.slice(0, 8).map((item, index) => (
          <span key={`${index}-${item}`} className="rounded-full border border-white/10 bg-white/5 px-2.5 py-0.5 text-[10px] text-slate-300">
            {item}
          </span>
        )) : <span className="text-xs text-slate-500">None</span>}
      </div>
    </div>
  );
}

function CompactLogList({ title, items, showAll = false }: { title: string; items: string[]; showAll?: boolean }) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-950/60 p-4">
      <p className="text-[11px] uppercase tracking-[0.22em] text-slate-400">{title}</p>
      <div className="app-scrollbar mt-3 grid gap-2 overflow-y-auto">
        {items.length > 0 ? (showAll ? items : items.slice(-6)).map((item, index) => (
          <div key={`${index}-${item}`} className="break-all rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs leading-5 text-slate-300">
            {item}
          </div>
        )) : <span className="text-xs text-slate-500">None</span>}
      </div>
    </div>
  );
}

function LoginDecisionModal({
  run,
  loading,
  onChoose,
}: {
  run: AnalysisRun;
  loading: boolean;
  onChoose: (action: "continue_without_login" | "continue_after_login") => Promise<void>;
}) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  const fallbackAt = run.progress.checkpoint?.expiresAt
    ? Math.min(new Date(run.progress.checkpoint.expiresAt).getTime(), new Date(run.updatedAt).getTime() + 120_000)
    : new Date(run.updatedAt).getTime() + 120_000;
  const remainingSeconds = Math.max(0, Math.ceil((fallbackAt - now) / 1000));

  const modal = (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-slate-950/82 px-3 py-4 sm:px-4 sm:py-6 backdrop-blur-md">
      <div className="glass-surface flex w-full max-w-[min(92vw,34rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden rounded-[1.35rem] p-4 shadow-[0_24px_80px_rgba(2,6,23,0.6)] sm:max-h-[calc(100vh-3rem)] sm:p-5">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <p className="text-[11px] uppercase tracking-[0.28em] text-cyan-300">Login detected</p>
          <h2 className="mt-2 text-xl font-semibold text-white sm:text-2xl">Continue with login?</h2>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            {run.progress.checkpoint?.instructions}
          </p>
          <div className="mt-4 rounded-2xl border border-amber-300/20 bg-amber-400/10 px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.22em] text-amber-200">Auto continue timer</p>
            <p className="mt-2 text-base font-semibold text-white sm:text-lg">{formatDuration(remainingSeconds)}</p>
            <p className="mt-1 text-xs text-amber-100/80">If there is no response within 2 minutes, the run continues without login.</p>
          </div>
        </div>
        <div className="mt-4 flex flex-col gap-2.5 border-t border-white/10 pt-4 sm:flex-row sm:justify-end">
          <button
            type="button"
            disabled={loading}
            onClick={() => void onChoose("continue_without_login")}
            className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-slate-200"
          >
            {loading ? "Continuing..." : "Continue without login"}
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={() => void onChoose("continue_after_login")}
            className="rounded-full border border-cyan-300/30 bg-cyan-400/10 px-4 py-2 text-sm text-cyan-100"
          >
            {loading ? "Continuing..." : "Continue with login"}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function FatalErrorModal({
  run,
  onClose,
}: {
  run: AnalysisRun;
  onClose: () => void;
}) {
  useEffect(() => {
    const { overflow } = document.body.style;
    document.body.style.overflow = "hidden";

    return () => {
      document.body.style.overflow = overflow;
    };
  }, []);

  const modal = (
    <div className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/84 px-3 py-4 sm:px-4 sm:py-6 backdrop-blur-md">
      <div className="glass-surface flex w-full max-w-[min(92vw,36rem)] max-h-[calc(100vh-1.5rem)] flex-col overflow-hidden rounded-[1.35rem] p-4 shadow-[0_24px_80px_rgba(2,6,23,0.65)] sm:max-h-[calc(100vh-3rem)] sm:p-5">
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <p className="text-[11px] uppercase tracking-[0.28em] text-rose-300">Run stopped</p>
          <h2 className="mt-2 text-xl font-semibold text-white sm:text-2xl">A fatal crawler error occurred</h2>
          <p className="mt-3 text-sm leading-6 text-slate-300">
            The active analysis process has been stopped. Review the error below before retrying the run.
          </p>
          <div className="mt-4 rounded-2xl border border-rose-300/20 bg-rose-400/10 px-4 py-3">
            <p className="text-[11px] uppercase tracking-[0.22em] text-rose-200">Error details</p>
            <p className="mt-2 break-words text-sm leading-6 text-rose-50">{run.error}</p>
          </div>
          <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-400">
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">Run ID: {run.runId}</span>
            <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1">Status: {run.status}</span>
          </div>
        </div>
        <div className="mt-4 flex justify-end border-t border-white/10 pt-4">
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-rose-300/30 bg-rose-400/10 px-4 py-2 text-sm text-rose-100"
          >
            Dismiss
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(modal, document.body);
}

function routeFromUrl(value: string) {
  try {
    return new URL(value).pathname || "/";
  } catch {
    return value;
  }
}

function humanizeRunStatus(run: AnalysisRun) {
  if (run.status === "completed") {
    return "Completed";
  }
  if (run.status === "failed") {
    return "Stopped";
  }
  if (run.status === "awaiting_checkpoint") {
    return "Waiting for input";
  }
  if (run.status === "running") {
    return "Running";
  }
  return "Queued";
}

function humanizeStageTitle(run: AnalysisRun) {
  if (run.status === "completed") {
    return "Run completed successfully";
  }
  if (run.status === "failed") {
    return "Run stopped before finishing";
  }
  if (run.status === "awaiting_checkpoint") {
    return "Waiting for a login or checkpoint decision";
  }
  return run.progress.stageLabel;
}

function humanizeStageSummary(run: AnalysisRun) {
  if (run.status === "completed") {
    return "The website scan finished without blocking errors.";
  }
  if (run.status === "failed") {
    return "The scan stopped early because the crawler hit a blocking problem.";
  }
  if (run.status === "awaiting_checkpoint") {
    return "The scan paused because it found a login or manual checkpoint.";
  }
  return run.progress.summary;
}

function humanizeStageTechnical(run: AnalysisRun) {
  if (run.status === "completed") {
    return "All crawl, interaction, and report steps finished successfully.";
  }
  if (run.status === "failed") {
    return "Review the error details and recent logs to understand what blocked the run.";
  }
  if (run.status === "awaiting_checkpoint") {
    return "Protected pages may stay out of scope until the checkpoint is resolved.";
  }
  return run.progress.technical;
}

function humanizeLastAction(label?: string) {
  if (!label) {
    return "No finished step yet";
  }
  if (label === "...") {
    return "Latest page analysis finished";
  }
  return label;
}

function friendlyPageName(title: string, url: string) {
  const route = routeFromUrl(url);
  const lower = `${title} ${route}`.toLowerCase();

  if (route === "/") {
    return title || "Home page";
  }
  if (lower.includes("login") || lower.includes("signin")) {
    return "Login page";
  }
  if (title) {
    return title;
  }
  return route;
}

function friendlyScopeLabel(scope: string) {
  if (scope === "queue") {
    return "Run started";
  }
  if (scope === "crawl" || scope === "crawler") {
    return "Pages discovered";
  }
  if (scope === "auth") {
    return "Login handling";
  }
  if (scope === "api") {
    return "API activity";
  }
  if (scope === "assertions") {
    return "Checks";
  }
  return scope;
}

function humanizeLogMessage(message: string) {
  return message
    .replace(/^started for /i, "Started scan for ")
    .replace(/^page /i, "Saved page ")
    .replace(/ stored$/i, "")
    .replace(/^checkpoint resumed with action:\s*/i, "Checkpoint continued with action: ")
    .replace(/^Detected a login surface \(Login\)\./i, "A login page was detected.")
    .replace(/continue_without_login/gi, "continue without login");
}

function normalizeScope(value: string) {
  const scope = value.toLowerCase();
  if (scope.includes("crawler")) {
    return "crawler";
  }
  if (scope.includes("api") || scope.includes("backend")) {
    return "api";
  }
  if (scope.includes("assert")) {
    return "assertions";
  }
  if (scope.includes("access")) {
    return "accessibility";
  }
  if (scope.includes("visual")) {
    return "visual";
  }
  if (scope.includes("auth") || scope.includes("checkpoint")) {
    return "auth";
  }
  return scope;
}

function toneForLevel(level: "info" | "warn" | "error") {
  if (level === "error") {
    return "bg-rose-300";
  }
  if (level === "warn") {
    return "bg-amber-300";
  }
  return "bg-cyan-300";
}

function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  }
  return `${String(totalMinutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatReadableDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours} hr ${minutes} min`;
  }
  if (minutes > 0) {
    return `${minutes} min ${seconds} sec`;
  }
  return `${seconds} sec`;
}

function buildMetricTrend(values: number[]) {
  const sample = (values.length > 0 ? values : [0]).slice(-6);
  const max = Math.max(...sample, 1);
  const min = Math.min(...sample, 0);
  const spread = Math.max(max - min, 1);

  return sample
    .map((value, index) => {
      const x = sample.length === 1 ? 50 : (index / (sample.length - 1)) * 100;
      const y = 20 - ((value - min) / spread) * 16;
      return `${x},${y}`;
    })
    .join(" ");
}

function describeRunScope(request: AnalysisRun["request"]) {
  return [
    { label: "Crawl profile", value: request.options.crawlProfile ?? "auto" },
    { label: "Max pages", value: String(request.options.maxPages) },
    { label: "Max depth", value: String(request.options.maxDepth) },
    { label: "Links per page", value: String(request.options.maxLinksPerPage) },
    { label: "Interactions per page", value: String(request.options.maxInteractionsPerPage) },
    { label: "Robots.txt", value: request.options.respectRobotsTxt ? "Respected" : "Ignored" },
    { label: "Behavior mode", value: request.options.strictBehaviorMode ? "Strict" : "Standard" },
    { label: "Login handling", value: request.options.promptForLogin ? "Prompt operator when login is detected" : "No login prompt" },
  ];
}

function buildRunLimitations(request: AnalysisRun["request"]) {
  const backend = request.backend ?? {};

  return [
    request.options.respectRobotsTxt
      ? "Routes disallowed by `robots.txt` may be skipped, so coverage reflects allowed crawl paths rather than the entire site."
      : "Because `robots.txt` is ignored for this run, coverage may include routes that a polite crawler would normally skip.",
    request.options.promptForLogin
      ? "Authenticated areas are only explored if the operator completes the login checkpoint during the run."
      : "Authenticated areas may remain untested unless a pre-authenticated session is supplied elsewhere.",
    "Lazy-loaded components, infinite scroll sections, or hidden state transitions may remain partially covered unless the crawler triggers them explicitly.",
    backend.githubRepoUrl || backend.uploadedPath
      ? "Backend correlation is best-effort and depends on how clearly observed requests map to the supplied repository or artifact context."
      : "Backend validation is limited because no repository or backend artifact context was supplied for this run.",
  ];
}

function buildRunSummaryStrip(
  run: AnalysisRun,
  metrics: {
    pagesFound: number;
    interactionsDetected: number;
    interactionsTested: number;
    failuresFound: number;
  },
): RunSummaryStrip {
  const loginDetected =
    Boolean(run.progress.checkpoint?.loginUrl) ||
    run.logs.some((item) => normalizeScope(item.scope) === "auth") ||
    run.pages.some((page) => /login|signin|auth/i.test(`${page.url} ${page.title}`));

  return {
    result:
      run.status === "completed"
        ? "Run completed successfully."
        : run.status === "failed"
          ? "Run stopped before finishing."
          : run.status === "awaiting_checkpoint"
            ? "Run is waiting for your input."
            : "Run is still in progress.",
    coverage: `The scan reached ${metrics.pagesFound} page${metrics.pagesFound === 1 ? "" : "s"} and checked ${metrics.interactionsTested}${metrics.interactionsDetected > 0 ? ` of ${metrics.interactionsDetected}` : ""} interaction${metrics.interactionsTested === 1 ? "" : "s"}.`,
    limitation: loginDetected
      ? "A login page was detected. If the run continued without login, protected pages may not be included."
      : "No major coverage blocker is visible from the current run state.",
    impact:
      metrics.failuresFound > 0
        ? `The run found ${metrics.failuresFound} issue${metrics.failuresFound === 1 ? "" : "s"}, so the captured flow needs review.`
        : "No failures were found in the scanned flow, so the visible public path looks stable from this run.",
  };
}

function buildPreviewPageSummary({
  run,
  preview,
  pageDetails,
  pageInteractions,
  pageFindings,
  pagesFound,
  currentRoute,
}: {
  run: AnalysisRun | null;
  preview:
    | {
        url: string;
        title: string;
        html?: string;
        previewImageUrl?: string;
        capturedAt: string;
        consoleEvents: string[];
        networkEvents: string[];
      }
    | null;
  pageDetails: AnalysisRun["pages"][number] | null;
  pageInteractions: AnalysisRun["interactions"];
  pageFindings: AnalysisRun["result"] extends infer _T ? AnalysisResponse["frontend"]["runtimeFindings"] : never;
  pagesFound: number;
  currentRoute: string;
}) {
  const routeText = currentRoute.toLowerCase();
  const titleText = `${preview?.title ?? ""} ${pageDetails?.title ?? ""}`.toLowerCase();
  const isLogin = /login|signin|auth/.test(`${routeText} ${titleText}`);
  const isShort = /shorts|video/.test(`${routeText} ${titleText}`);
  const isHome = currentRoute === "/";
  const pageType = isLogin
    ? "Login or sign-in page"
    : isShort
      ? "Short video content page"
      : isHome
        ? "Home page"
        : "Website content page";

  const issueCount = pageFindings.length;
  const failedInteractions = pageInteractions.filter((item) => item.result === "FAIL").length;
  const hasIssues = issueCount > 0 || failedInteractions > 0;
  const loginLimited = Boolean(run?.progress.checkpoint?.loginUrl) && !isLogin;

  const whyItems = [
    isHome
      ? "This page is the main entry point of the website and helps define the primary public journey."
      : isLogin
        ? "This page controls access to protected areas, so it strongly affects what the run can and cannot cover."
        : "This page is part of the visible user journey that the crawler reached during the run.",
    `The run reached this page after scanning ${pagesFound} ${pagesFound === 1 ? "page" : "pages"} in the current session.`,
    run?.status === "completed"
      ? "This page is part of the finished run result and can be used in final review."
      : "This page reflects the latest live state captured during the active run.",
  ];

  const checkedItems = [
    preview?.previewImageUrl ? "A visual screenshot of the page was captured." : "A rendered view was captured from the browser session.",
    pageInteractions.length > 0
      ? `${pageInteractions.length} interaction${pageInteractions.length === 1 ? "" : "s"} were checked on this page.`
      : "No page-specific interaction checks were captured for this page.",
    pageDetails
      ? `${pageDetails.buttons.length} buttons, ${pageDetails.links.length} links, and ${pageDetails.forms.length} forms were detected here.`
      : "Route-level structure details are limited for this page.",
  ];

  const noticedItems = [
    isShort
      ? "This page uses a media-first layout with content playback and engagement controls."
      : isLogin
        ? "This page appears to be focused on authentication and access control."
        : "This page appears to be part of the normal visible site experience.",
    pageDetails?.headings.length
      ? `Visible headings include ${pageDetails.headings.slice(0, 2).join(", ")}.`
      : `The active route is ${currentRoute}.`,
    issueCount > 0
      ? `${issueCount} runtime issue${issueCount === 1 ? "" : "s"} were linked to this page.`
      : failedInteractions > 0
        ? `${failedInteractions} interaction check${failedInteractions === 1 ? "" : "s"} failed on this page.`
        : "No page-specific failures were detected from the captured evidence.",
  ];

  const result = hasIssues
    ? "Needs review"
    : loginLimited
      ? "Login-limited"
      : "No issues detected";
  const resultTone = hasIssues
    ? "border-rose-300/20 bg-rose-400/10 text-rose-100"
    : loginLimited
      ? "border-amber-300/20 bg-amber-400/10 text-amber-100"
      : "border-emerald-300/20 bg-emerald-400/10 text-emerald-100";

  const whyItMatters = isLogin
    ? "This page affects whether the run can access protected routes and signed-in user flows."
    : isShort
      ? "This is a user-facing content page, so it helps validate the real browsing experience."
      : "This page helps explain the visible path the user can reach during the run.";

  return {
    pageType,
    whyItMatters,
    whyItems,
    checkedItems,
    noticedItems,
    result,
    resultTone,
  };
}

function buildRunIntelligence(
  run: AnalysisRun,
  metrics: {
    pagesFound: number;
    interactionsDetected: number;
    interactionsTested: number;
    failuresFound: number;
    currentRoute: string;
  },
): RunIntelligence {
  const result = run.result;
  const pages = result?.frontend.pages ?? run.pages;
  const failureClusters = result?.frontend.failureClusters ?? run.failureClusters;
  const findings = result?.frontend.runtimeFindings ?? [];
  const backendValidation = result?.backendValidation;
  const interactiveCount = result?.frontend.interactiveElements.length ?? metrics.interactionsDetected;
  const authSeen =
    run.status === "awaiting_checkpoint" ||
    Boolean(run.progress.checkpoint?.loginUrl) ||
    pages.some((page) => /login|signin|auth/i.test(`${page.url} ${page.title}`));

  const topRoutes = Array.from(new Set(pages.map((page) => page.routePath || routeFromUrl(page.url)).filter(Boolean))).slice(0, 4);
  const dominantFindingTypes = Array.from(new Set(findings.map((finding) => finding.type))).slice(0, 3);

  const did = [
    `The run explored ${metrics.pagesFound} page${metrics.pagesFound === 1 ? "" : "s"} and observed ${interactiveCount} interactive element${interactiveCount === 1 ? "" : "s"} in scope.`,
    `It completed ${metrics.interactionsTested} interaction check${metrics.interactionsTested === 1 ? "" : "s"}${metrics.interactionsDetected > 0 ? ` out of ${metrics.interactionsDetected} detected opportunities` : ""}.`,
    `The latest active route was ${metrics.currentRoute}, and the current execution stage is ${run.progress.stageLabel.toLowerCase()}.`,
  ];

  const scope = describeRunScope(run.request).map((item) => `${item.label}: ${item.value}`);

  const websiteInsights = [
    topRoutes.length > 0
      ? `Primary routes surfaced in this run include ${topRoutes.join(", ")}.`
      : "No stable route inventory has been captured yet.",
    authSeen
      ? "Authentication or sign-in behavior is part of this website flow, so protected areas may materially affect user journeys."
      : "No strong authentication checkpoint signal was detected in the currently captured routes.",
    failureClusters.length > 0
      ? `The run grouped issues into ${failureClusters.length} failure cluster${failureClusters.length === 1 ? "" : "s"}, suggesting recurring problems instead of isolated noise.`
      : "No recurring failure clusters have been grouped yet from the current evidence.",
    dominantFindingTypes.length > 0
      ? `Observed issue patterns are concentrated around ${dominantFindingTypes.join(", ")}.`
      : "Runtime findings have not yet established a dominant issue pattern.",
    backendValidation?.provided
      ? backendValidation.matchedEndpoints.length > 0
        ? `Backend context was supplied and ${backendValidation.matchedEndpoints.length} endpoint match${backendValidation.matchedEndpoints.length === 1 ? "" : "es"} were correlated.`
        : "Backend context was supplied, but the run did not produce strong endpoint matches yet."
      : "No backend context was supplied, so website insights are based on frontend runtime evidence only.",
  ];

  const limitations = buildRunLimitations(run.request);

  const nextSteps = [
    run.status === "completed"
      ? "Review Findings next to confirm severity, defect types, and whether the recurring clusters reflect user-visible risk."
      : run.status === "failed"
        ? "Review the fatal error and recent logs to determine whether the stop condition came from the website, authentication, or the crawler environment."
        : run.status === "awaiting_checkpoint"
          ? "Decide whether to complete login so the run can cover protected routes and post-auth user journeys."
          : "Keep the run open and monitor whether coverage moves beyond the current route and stage.",
    authSeen
      ? "Prioritize login, account, and redirect flows because they appear central to this website."
      : "Prioritize high-traffic navigation and interaction-heavy pages surfaced in the captured route list.",
    metrics.failuresFound > 0 || findings.length > 0
      ? "Use the generated findings and failure clusters to create focused regression tests around repeated breakpoints."
      : "If the website looks business-critical, run a second pass with authenticated coverage or a more focused target journey.",
  ];

  const confidence = deriveConfidence(run, {
    findingsCount: findings.length,
    failureClustersCount: failureClusters.length,
    pagesFound: metrics.pagesFound,
    interactionsTested: metrics.interactionsTested,
    authSeen,
  });

  return {
    overview:
      run.status === "completed"
        ? "This run has finished and the panel below translates the captured evidence into website-focused meaning rather than raw telemetry."
        : "This run is still live or partially complete, so the insights below reflect the latest captured evidence and current execution state.",
    did,
    scope,
    websiteInsights,
    limitations,
    nextSteps,
    confidence,
  };
}

function deriveConfidence(
  run: AnalysisRun,
  details: {
    findingsCount: number;
    failureClustersCount: number;
    pagesFound: number;
    interactionsTested: number;
    authSeen: boolean;
  },
): RunIntelligence["confidence"] {
  const reasons: string[] = [];

  if (details.pagesFound >= 5) {
    reasons.push("Multiple routes were discovered, which improves coverage confidence.");
  } else {
    reasons.push("Only a limited route set was captured, so coverage may still be narrow.");
  }

  if (details.interactionsTested >= 10) {
    reasons.push("A meaningful number of interaction checks completed successfully.");
  } else {
    reasons.push("Interaction evidence is still shallow, so behavioral coverage is limited.");
  }

  if (details.authSeen && run.status !== "completed") {
    reasons.push("Authentication is part of the flow and incomplete auth handling may hide protected behavior.");
  }

  if (run.status === "failed") {
    reasons.push("The run stopped early, so conclusions should be treated as partial.");
    return {
      level: "Low",
      summary: "Evidence is useful for triage, but the run stopped before full coverage could be established.",
      reasons,
    };
  }

  if (run.status === "awaiting_checkpoint" || (details.authSeen && details.pagesFound < 5)) {
    return {
      level: "Low",
      summary: "Coverage is currently constrained by authentication or limited route discovery.",
      reasons,
    };
  }

  if (run.status === "completed" && details.pagesFound >= 5 && details.interactionsTested >= 10) {
    return {
      level: "High",
      summary: "The run completed with broad enough route and interaction evidence to support strong website-level conclusions.",
      reasons,
    };
  }

  return {
    level: "Medium",
    summary: "The run provides meaningful evidence, but some routes, journeys, or interaction depth may still be underrepresented.",
    reasons,
  };
}
