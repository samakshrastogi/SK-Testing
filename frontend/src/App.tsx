import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { CompareView } from "./components/CompareView";
import { FindingsView } from "./components/FindingsView";
import { GlobalFilterModal } from "./components/GlobalFilterModal";
import { HistoryView } from "./components/HistoryView";
import { MobileActionBar } from "./components/MobileActionBar";
import { OverviewView } from "./components/OverviewView";
import { PagesView } from "./components/PagesView";
import { ReportView } from "./components/ReportView";
import { RunView } from "./components/RunView";
import { TestsView } from "./components/TestsView";
import { TopBar } from "./components/TopBar";
import { TopStatusStrip } from "./components/TopStatusStrip";
import { ViewTabs } from "./components/ViewTabs";
import { runtime } from "./config/runtime";
import type { AnalysisResponse, AnalysisRun, AnalysisSubmission, AppView, GlobalFilters, SavedProject } from "./types/analysis";

const API_BASE_URL = runtime.apiBaseUrl;
const ANALYSIS_API_BASE_URL = `${API_BASE_URL}${runtime.analysisApiPath}`;
const DEFAULT_ANALYSIS_OPTIONS = runtime.defaultAnalysisOptions;
const SAVED_PROJECTS_KEY = "sk-crawlpulse:saved-projects";
const APP_STATE_KEY = "sk-crawlpulse:app-state";
const THEME_MODE_KEY = "pulse:theme-mode";

const toProjectName = (targetUrl: string) => {
  try {
    return new URL(targetUrl).hostname;
  } catch {
    return targetUrl || "project";
  }
};

const toWebsiteName = (targetUrl: string) => {
  const value = targetUrl.trim();
  if (!value) {
    return "";
  }

  try {
    return new URL(value).hostname;
  } catch {
    return value;
  }
};

const defaultWebsiteFilter = (runs: AnalysisRun[], fallbackUrl = "") => {
  const latestRun = runs[0];
  const latestWebsite = latestRun ? toWebsiteName(latestRun.request.targetUrl) : "";
  return latestWebsite || toWebsiteName(fallbackUrl) || "";
};

const mergeRunSnapshot = (previous: AnalysisRun | null, incoming: AnalysisRun): AnalysisRun => {
  if (!previous || previous.runId !== incoming.runId) {
    return incoming;
  }

  const preserveLiveCollections =
    !incoming.result && ["queued", "running", "awaiting_checkpoint"].includes(incoming.status);

  return {
    ...incoming,
    logs: preserveLiveCollections && incoming.logs.length === 0 ? previous.logs : incoming.logs,
    artifacts: preserveLiveCollections && (!incoming.artifacts || incoming.artifacts.length === 0)
      ? previous.artifacts
      : incoming.artifacts,
    pages: preserveLiveCollections && incoming.pages.length === 0 ? previous.pages : incoming.pages,
    interactions:
      preserveLiveCollections && incoming.interactions.length === 0 ? previous.interactions : incoming.interactions,
    failureClusters:
      preserveLiveCollections && incoming.failureClusters.length === 0
        ? previous.failureClusters
        : incoming.failureClusters,
    result: incoming.result ?? previous.result,
    error: incoming.error ?? previous.error,
  };
};

export default function App() {
  const [themeMode, setThemeMode] = useState<"dark" | "light">("dark");
  const [targetUrl, setTargetUrl] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [uploadedPath, setUploadedPath] = useState("");
  const [result, setResult] = useState<AnalysisResponse | null>(null);
  const [currentRun, setCurrentRun] = useState<AnalysisRun | null>(null);
  const [historyRuns, setHistoryRuns] = useState<AnalysisRun[]>([]);
  const [comparisonRuns, setComparisonRuns] = useState<AnalysisRun[]>([]);
  const [savedProjects, setSavedProjects] = useState<SavedProject[]>([]);
  const [error, setError] = useState("");
  const [urlError, setUrlError] = useState("");
  const [loading, setLoading] = useState(false);
  const [activeView, setActiveView] = useState<AppView>("overview");
  const [restored, setRestored] = useState(false);
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [globalFilters, setGlobalFilters] = useState<GlobalFilters>({
    website: defaultWebsiteFilter([], ""),
    route: "all",
    status: "all",
    severity: "all",
    issueType: "all",
  });
  const streamRef = useRef<EventSource | null>(null);
  const hasActiveFilters =
    Boolean(globalFilters.website) ||
    globalFilters.route !== "all" ||
    globalFilters.status !== "all" ||
    globalFilters.severity !== "all" ||
    globalFilters.issueType !== "all";

  const websiteOptions = Array.from(
    new Set(
      [
        toWebsiteName(currentRun?.request.targetUrl ?? ""),
        toWebsiteName(targetUrl),
        ...historyRuns.map((run) => toWebsiteName(run.request.targetUrl)),
      ].filter(Boolean),
    ),
  ).sort((left, right) => left.localeCompare(right));

  const filteredCurrentRun =
    !globalFilters.website
      ? currentRun
      : ([currentRun, ...historyRuns].filter((run): run is AnalysisRun => Boolean(run))).find(
          (run) => toWebsiteName(run.request.targetUrl) === globalFilters.website,
        ) ?? null;

  const filteredResult =
    !globalFilters.website
      ? result
      : filteredCurrentRun?.result ??
        historyRuns.find((run) => toWebsiteName(run.request.targetUrl) === globalFilters.website && run.result)?.result ??
        null;

  useEffect(() => {
    const storedTheme = window.localStorage.getItem(THEME_MODE_KEY);
    if (storedTheme === "light" || storedTheme === "dark") {
      setThemeMode(storedTheme);
    }

    const restoreState = async () => {
      const storedProjects = window.localStorage.getItem(SAVED_PROJECTS_KEY);
      if (storedProjects) {
        try {
          setSavedProjects(JSON.parse(storedProjects) as SavedProject[]);
        } catch {
          window.localStorage.removeItem(SAVED_PROJECTS_KEY);
        }
      }

      let restoredRunId: string | null = null;
      const storedState = window.localStorage.getItem(APP_STATE_KEY);
      if (storedState) {
        try {
          const parsed = JSON.parse(storedState) as {
            targetUrl?: string;
            repoUrl?: string;
            uploadedPath?: string;
            activeView?: AppView;
            globalFilters?: GlobalFilters;
            selectedRunId?: string | null;
          };

          setTargetUrl(parsed.targetUrl ?? "");
          setRepoUrl(parsed.repoUrl ?? "");
          setUploadedPath(parsed.uploadedPath ?? "");
          setActiveView(parsed.activeView ?? "overview");
          setGlobalFilters(
            parsed.globalFilters ?? {
              website: defaultWebsiteFilter([], parsed.targetUrl ?? ""),
              route: "all",
              status: "all",
              severity: "all",
              issueType: "all",
            },
          );
          restoredRunId = parsed.selectedRunId ?? null;
        } catch {
          window.localStorage.removeItem(APP_STATE_KEY);
        }
      }

      await fetchHistory();

      if (restoredRunId) {
        try {
          const fullRun = await fetchRun(restoredRunId);
          setCurrentRun(fullRun);
          if (fullRun.result) {
            setResult(fullRun.result);
          }
        } catch {
          // Ignore stale selection.
        }
      }

      setRestored(true);
    };

    void restoreState();

    return () => streamRef.current?.close();
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    window.localStorage.setItem(THEME_MODE_KEY, themeMode);
  }, [themeMode]);

  useEffect(() => {
    window.localStorage.setItem(SAVED_PROJECTS_KEY, JSON.stringify(savedProjects));
  }, [savedProjects]);

  useEffect(() => {
    if (!restored) {
      return;
    }

    window.localStorage.setItem(
      APP_STATE_KEY,
      JSON.stringify({
        targetUrl,
        repoUrl,
        uploadedPath,
        activeView,
        globalFilters,
        selectedRunId: currentRun?.runId ?? null,
      }),
    );
  }, [
    activeView,
    currentRun?.runId,
    globalFilters,
    repoUrl,
    restored,
    targetUrl,
    uploadedPath,
  ]);

  useEffect(() => {
    streamRef.current?.close();
    streamRef.current = null;

    if (!currentRun || !["queued", "running", "awaiting_checkpoint"].includes(currentRun.status)) {
      return;
    }

    const stream = new EventSource(`${ANALYSIS_API_BASE_URL}/runs/${currentRun.runId}/stream`);
    streamRef.current = stream;

    stream.onmessage = (event) => {
      const nextRun = JSON.parse(event.data) as AnalysisRun;
      setCurrentRun((previous) => {
        const mergedRun = mergeRunSnapshot(previous, nextRun);
        setHistoryRuns((runs) => [mergedRun, ...runs.filter((item) => item.runId !== mergedRun.runId)]);
        if (mergedRun.result) {
          setResult(mergedRun.result);
        }
        if (mergedRun.status === "completed" || mergedRun.status === "failed") {
          setLoading(false);
          stream.close();
        }
        return mergedRun;
      });
    };

    stream.onerror = () => {
      stream.close();
      streamRef.current = null;
    };

    return () => stream.close();
  }, [currentRun?.runId, currentRun?.status]);

  const validateTargetUrl = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) {
      return "Target website URL is required.";
    }

    try {
      const parsed = new URL(trimmed);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return "Use an http or https website URL.";
      }
      return "";
    } catch {
      return "Enter a valid website URL, for example https://example.com.";
    }
  };

  const updateSavedProject = (project: SavedProject) => {
    setSavedProjects((current) => [
      project,
      ...current.filter((item) => item.id !== project.id),
    ]);
  };

  const saveCurrentProject = (pinned: boolean) => {
    if (!targetUrl.trim()) {
      return;
    }

    const existing =
      savedProjects.find((item) => item.targetUrl === targetUrl.trim()) ??
      savedProjects.find((item) => item.name === toProjectName(targetUrl));

    updateSavedProject({
      id: existing?.id ?? crypto.randomUUID(),
      name: existing?.name ?? toProjectName(targetUrl),
      targetUrl: targetUrl.trim(),
      repoUrl: repoUrl.trim(),
      uploadedPath: uploadedPath.trim(),
      pinned: pinned || existing?.pinned || false,
      lastUsedAt: new Date().toISOString(),
    });
  };

  const fetchHistory = async () => {
    try {
      const response = await fetch(`${ANALYSIS_API_BASE_URL}/runs`);
      const runs = (await response.json()) as AnalysisRun[];
      if (response.ok) {
        setHistoryRuns(runs);
        setGlobalFilters((current) =>
          !current.website
            ? {
                ...current,
                website: defaultWebsiteFilter(runs, targetUrl),
              }
            : current,
        );
      }
    } catch {
      // Keep current history state.
    }
  };

  const fetchRun = async (runId: string) => {
    const response = await fetch(`${ANALYSIS_API_BASE_URL}/runs/${runId}`);
    const run = (await response.json()) as AnalysisRun;
    if (!response.ok) {
      throw new Error("Failed to fetch run");
    }
    return run;
  };

  const retryRun = async (runId: string) => {
    setLoading(true);
    const response = await fetch(`${ANALYSIS_API_BASE_URL}/runs/${runId}/retry`, {
      method: "POST",
    });
    const nextRun = (await response.json()) as AnalysisRun & { error?: string };
    if (!response.ok) {
      setLoading(false);
      throw new Error(nextRun.error ?? "Retry failed");
    }

    setCurrentRun(nextRun);
    setHistoryRuns((runs) => [nextRun, ...runs.filter((item) => item.runId !== nextRun.runId)]);
    setGlobalFilters((current) => ({ ...current, website: toWebsiteName(nextRun.request.targetUrl) || current.website }));
    setActiveView("run");
  };

  const replaceCurrentRun = (nextRun: AnalysisRun) => {
    setCurrentRun(nextRun);
    setHistoryRuns((runs) => [nextRun, ...runs.filter((item) => item.runId !== nextRun.runId)]);
    setGlobalFilters((current) => ({ ...current, website: toWebsiteName(nextRun.request.targetUrl) || current.website }));
    setActiveView("run");
    setLoading(["queued", "running", "awaiting_checkpoint"].includes(nextRun.status));
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextUrlError = validateTargetUrl(targetUrl);
    setUrlError(nextUrlError);
    if (nextUrlError) {
      return;
    }

    setLoading(true);
    setError("");
    setResult(null);
    saveCurrentProject(false);

    const payload: AnalysisSubmission = {
      targetUrl,
      backend: {
        githubRepoUrl: repoUrl || undefined,
        uploadedPath: uploadedPath || undefined,
      },
      options: {
        maxPages: DEFAULT_ANALYSIS_OPTIONS.maxPages,
        maxLinksPerPage: DEFAULT_ANALYSIS_OPTIONS.maxLinksPerPage,
        maxDepth: DEFAULT_ANALYSIS_OPTIONS.maxDepth,
        maxInteractionsPerPage: DEFAULT_ANALYSIS_OPTIONS.maxInteractionsPerPage,
        respectRobotsTxt: DEFAULT_ANALYSIS_OPTIONS.respectRobotsTxt,
        streamHtmlPreview: DEFAULT_ANALYSIS_OPTIONS.streamHtmlPreview,
        crawlProfile: DEFAULT_ANALYSIS_OPTIONS.crawlProfile,
        strictBehaviorMode: DEFAULT_ANALYSIS_OPTIONS.strictBehaviorMode,
        promptForLogin: DEFAULT_ANALYSIS_OPTIONS.promptForLogin,
        loginPrompt: {
          enabled: DEFAULT_ANALYSIS_OPTIONS.loginPromptEnabled,
          checkpointLabel: DEFAULT_ANALYSIS_OPTIONS.loginPromptLabel,
          timeoutSeconds: DEFAULT_ANALYSIS_OPTIONS.loginPromptTimeoutSeconds,
        },
      },
    };

    try {
      const response = await fetch(`${ANALYSIS_API_BASE_URL}/run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });

      const nextRun = (await response.json()) as AnalysisRun & { error?: string };
      if (!response.ok) {
        throw new Error(nextRun.error ?? "Analysis failed");
      }

      setCurrentRun(nextRun);
      setHistoryRuns((runs) => [nextRun, ...runs.filter((item) => item.runId !== nextRun.runId)]);
      setGlobalFilters((current) => ({ ...current, website: toWebsiteName(nextRun.request.targetUrl) || current.website }));
      setActiveView("run");
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : "Analysis failed");
      setCurrentRun(null);
      setLoading(false);
    }
  };

  const renderActiveView = () => {
    switch (activeView) {
      case "overview":
        return <OverviewView result={filteredResult} />;
      case "run":
        return (
          <RunView
            targetUrl={targetUrl}
            repoUrl={repoUrl}
            uploadedPath={uploadedPath}
            loading={loading}
            error={error}
            urlError={urlError}
            currentRun={currentRun}
            savedProjects={savedProjects}
            onRetryRun={retryRun}
            onReplaceRun={replaceCurrentRun}
            onSubmit={onSubmit}
            onTargetUrlChange={(value) => {
              setTargetUrl(value);
              setUrlError(validateTargetUrl(value));
            }}
            onRepoUrlChange={setRepoUrl}
            onUploadedPathChange={setUploadedPath}
          />
        );
      case "pages":
        return <PagesView result={filteredResult} filters={globalFilters} />;
      case "findings":
        return <FindingsView result={filteredResult} filters={globalFilters} />;
      case "tests":
        return <TestsView result={filteredResult} filters={globalFilters} />;
      case "report":
        return <ReportView result={filteredResult} filters={globalFilters} />;
      case "history":
        return (
          <HistoryView
            filters={globalFilters}
            runs={historyRuns}
            onSelectRun={async (run) => {
              setError("");
              setLoading(true);
              try {
                const fullRun = await fetchRun(run.runId);
                setCurrentRun(fullRun);
                setHistoryRuns((runs) => [fullRun, ...runs.filter((item) => item.runId !== fullRun.runId)]);
                setGlobalFilters((current) => ({
                  ...current,
                  website: toWebsiteName(fullRun.request.targetUrl) || current.website,
                }));
                if (fullRun.result) {
                  setResult(fullRun.result);
                  setActiveView((current) => (current === "history" ? "overview" : current));
                } else {
                  setActiveView((current) => (current === "history" ? "run" : current));
                }
              } catch (selectionError) {
                setError(selectionError instanceof Error ? selectionError.message : "Failed to open run");
              } finally {
                setLoading(false);
              }
            }}
          />
        );
      case "compare":
        return (
          <CompareView
            availableRuns={historyRuns}
            runs={comparisonRuns}
            onCompareRuns={async (runIds) => {
              const runs = await Promise.all(runIds.map((runId) => fetchRun(runId)));
              setComparisonRuns(runs);
            }}
          />
        );
      default:
        return null;
    }
  };

  return (
    <main
      className={`min-h-screen overflow-x-hidden text-slate-100 ${
        themeMode === "light"
          ? "bg-[radial-gradient(circle_at_top,#f8fdff_0%,#eef6ff_38%,#e2ebf5_100%)]"
          : "bg-[radial-gradient(circle_at_top,#162033_0%,#0b1220_45%,#030712_100%)]"
      }`}
    >
      <GlobalFilterModal
        open={filterModalOpen}
        filters={globalFilters}
        onChange={setGlobalFilters}
        onClose={() => setFilterModalOpen(false)}
        result={filteredResult}
        currentRun={filteredCurrentRun}
      />

      <div className="mx-auto w-full max-w-[1600px] px-4 py-4 pb-24 sm:px-6 md:pb-6">
        <div className="grid min-w-0 gap-3">
          <TopBar
            themeMode={themeMode}
            onThemeToggle={() => setThemeMode((current) => (current === "dark" ? "light" : "dark"))}
          />
          <ViewTabs
            activeView={activeView}
            onViewChange={setActiveView}
            websiteOptions={websiteOptions}
            selectedWebsite={globalFilters.website}
            onWebsiteChange={(website) => setGlobalFilters((current) => ({ ...current, website }))}
          />
          {activeView !== "run" ? (
            <TopStatusStrip
              activeView={activeView}
              currentRun={filteredCurrentRun}
              result={filteredResult}
              onOpenFilters={activeView === "overview" ? () => setFilterModalOpen(true) : undefined}
              hasActiveFilters={hasActiveFilters}
            />
          ) : null}

          <section className="min-w-0 overflow-x-hidden">{renderActiveView()}</section>
        </div>
      </div>

      <MobileActionBar
        canRetry={currentRun?.status === "failed"}
        canCompare={historyRuns.length >= 2}
        canSave={Boolean(targetUrl.trim())}
        onRun={() => setActiveView("run")}
        onRetry={() => {
          if (currentRun?.status === "failed") {
            void retryRun(currentRun.runId);
          }
        }}
        onCompare={() => setActiveView("compare")}
        onSave={() => saveCurrentProject(true)}
      />
    </main>
  );
}
