# SK CrawlPulse

SK CrawlPulse is a full-stack autonomous web QA workspace. It crawls a target website with Playwright, inspects pages and interactions, captures evidence, generates structured test cases, correlates observed API traffic with optional backend context, and presents the results in a React dashboard with live run updates.

This repository contains:

- a React + Vite operator console in `frontend/`
- a Node.js + Express + TypeScript analysis API in `backend/`
- sample report material in `docs/`

## What the project does

Given a target URL, SK CrawlPulse can:

- discover pages, routes, links, forms, inputs, and visible interactive elements
- execute interaction checks and capture before/after evidence
- detect runtime issues such as request failures, JS exceptions, accessibility risks, boundary-limit problems, and visual instability signals
- run scenario-oriented probes for flows like auth, search, forms, pagination, tables, filters, uploads, and cart-like actions
- stream run progress to the frontend through Server-Sent Events
- persist runs, pages, logs, interactions, artifacts, and completed reports in MongoDB
- retry failed runs and resume around failed pages or interactions
- raise login checkpoints and optionally continue in a dedicated headed login session
- compare historical runs to review new, fixed, and persistent issues

## Tech stack

- Frontend: React 19, TypeScript, Vite, Tailwind CSS
- Backend: Node.js, Express 5, TypeScript
- Browser automation: Playwright
- Persistence: MongoDB with Mongoose
- Streaming: Server-Sent Events

## Architecture

```mermaid
flowchart LR
  A["Operator UI"] --> B["POST /api/analysis/run"]
  B --> C["Analysis queue + worker"]
  C --> D["Playwright crawler"]
  D --> E["Deep analysis + scenario packs"]
  E --> F["Test generation + backend validation"]
  F --> G["Report assembly + MongoDB persistence"]
  G --> H["SSE stream + dashboard views"]
```

### Runtime flow

1. The operator submits a website URL and optional backend ownership context.
2. The backend creates a queued analysis run in MongoDB.
3. A worker claims the run and launches Playwright.
4. The crawler discovers pages, extracts UI structure, tracks network traffic, and tests interactions.
5. Deep analysis adds accessibility, visual, API, boundary, and scenario-pack findings.
6. The platform generates test cases and builds a report package.
7. Progress snapshots are streamed live to the frontend.
8. Final results remain available in history, report, findings, tests, and comparison views.

## Repository structure

```text
sk-testing/
  backend/
    src/
      app.ts
      server.ts
      config/             environment and MongoDB setup
      middleware/         Express error handling
      lib/                shared backend primitives
      models/             Mongoose models for runs, pages, logs, interactions, artifacts
      modules/
        frontend/         crawler, deep analysis, test generation
        backend/          API/backend correlation
        platform/         queueing, worker execution, streaming, retention
        reporting/        report and flowchart generation
      routes/             REST API routes
      types/              shared backend-side contracts
      utils/              URL helpers
  frontend/
    src/
      App.tsx             main operator shell
      components/         dashboard views and UI sections
      config/             frontend runtime configuration
      data/               dashboard metadata/content helpers
      types/              frontend contracts
  docs/
    project-overview.md
    examples/
      report-example.json
      report-pdf-outline.md
```

## Main frontend views

- `Overview`: high-level summary of coverage, findings, and report signals
- `Run`: target submission, live progress, retry flow, and checkpoint handling
- `Pages`: discovered routes, headings, buttons, links, forms, and HTML previews
- `Findings`: runtime findings with filtering by route, severity, status, and issue type
- `Tests`: generated QA test cases with evidence and issue summaries
- `Report`: report sections, backend observations, and Mermaid flow output
- `History`: previously stored runs with reopen support
- `Compare`: side-by-side run comparison for regressions and fixes

## Main backend capabilities

### Analysis API

The backend exposes these core endpoints:

- `GET /health`
- `POST /api/analysis/run`
- `GET /api/analysis/runs`
- `GET /api/analysis/runs/:runId`
- `GET /api/analysis/runs/:runId/stream`
- `POST /api/analysis/runs/:runId/retry`
- `POST /api/analysis/runs/:runId/checkpoint/continue`
- `POST /api/analysis/runs/:runId/checkpoint/login-run`

### Analysis engine

Key implementation areas:

- `backend/src/modules/frontend/crawler.ts`
  Crawls same-origin pages, extracts structure, tracks network requests, captures previews, tests interactions, and handles login/checkpoint flows.
- `backend/src/modules/frontend/deepAnalysis.ts`
  Adds accessibility checks, visual-overflow checks, API assertions, boundary probes, and scenario-pack execution.
- `backend/src/modules/frontend/testGenerator.ts`
  Converts collected evidence into categorized QA test cases.
- `backend/src/modules/backend/apiValidator.ts`
  Correlates observed API usage with optional repository or uploaded-path ownership signals.
- `backend/src/modules/platform/analysisService.ts`
  Owns queue draining, worker orchestration, buffering, streaming, retry creation, checkpoint continuation, and run completion/failure handling.
- `backend/src/modules/reporting/reportBuilder.ts`
  Builds overview/issues/performance sections, Mermaid flowcharts, and PDF-outline content.

## Local setup

### Prerequisites

- Node.js and npm
- MongoDB reachable through a connection string
- A Chromium-compatible browser available for Playwright

### Environment

Create `backend/.env` with values appropriate for your machine:

```env
PORT=5000
MONGO_URI=mongodb://127.0.0.1:27017/sk-crawlpulse
CORS_ORIGIN=http://localhost:5173
ARTIFACTS_DIR=artifacts
PLAYWRIGHT_HEADLESS=true
CRAWLER_TIMEOUT_MS=20000
CRAWLER_MAX_PAGES=50
CRAWLER_MAX_LINKS_PER_PAGE=80
CRAWLER_MAX_DEPTH=4
CRAWLER_MAX_INTERACTIONS_PER_PAGE=16
ARTIFACT_RETENTION_DAYS=14
ARTIFACT_CLEANUP_INTERVAL_MS=3600000
ARTIFACT_CLEANUP_ENABLED=true
```

Optional:

- `BROWSER_EXECUTABLE_PATH` to force a specific browser binary
- `VITE_API_BASE_URL` in the frontend environment if the API is not at `http://localhost:5000`

### Install

```bash
cd backend
npm install

cd ../frontend
npm install
```

### Run in development

Terminal 1:

```bash
cd backend
npm run dev
```

Terminal 2:

```bash
cd frontend
npm run dev
```

Then open the Vite app URL shown by the frontend dev server, usually `http://localhost:5173`.

## Build

Backend:

```bash
cd backend
npm run build
```

Frontend:

```bash
cd frontend
npm run build
```

Both builds are currently passing in this workspace.

## Output and stored artifacts

The platform produces:

- stored run metadata and progress snapshots
- discovered page inventories
- interaction results
- live and failure screenshots
- scenario and boundary evidence
- generated QA test cases
- backend/API validation observations
- report sections and Mermaid flowchart content

Generated file artifacts are written under `backend/artifacts/` and are intentionally ignored by Git.

## Documentation and examples

- [Project overview](C:/Users/samrasto/OneDrive%20-%20Nokia/Desktop/sk-testing/docs/project-overview.md)
- [Sample report outline](C:/Users/samrasto/OneDrive%20-%20Nokia/Desktop/sk-testing/docs/examples/report-pdf-outline.md)
- [Sample report payload](C:/Users/samrasto/OneDrive%20-%20Nokia/Desktop/sk-testing/docs/examples/report-example.json)

## Current limitations

- There is no root-level workspace runner yet; frontend and backend are started separately.
- The repository does not currently include automated test suites.
- MongoDB is required for the backend to start.
- Some analysis behavior is heuristic by design and depends on the target website structure.
- Large crawls and headed login flows can create substantial local artifacts.

## Suggested next improvements

- add `backend/.env.example` and optional `frontend/.env.example`
- add a root workspace script for install, dev, and build
- add automated tests for API routes, orchestration, and key frontend views
- add CI validation for build, lint, and type safety
- add exportable polished PDF generation for final reports
