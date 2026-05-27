import path from "path";
import cors from "cors";
import express from "express";
import { env } from "./config/env";
import { analysisRouter } from "./routes/analysis";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler";

const app = express();

app.use(
  cors({
    origin: env.runtime.corsOrigin === "*" ? true : env.runtime.corsOrigin,
    credentials: env.runtime.corsCredentials,
  }),
);
app.use(express.json({ limit: env.runtime.jsonBodyLimit }));
app.use(env.runtime.artifactsPublicRoute, express.static(path.resolve(process.cwd(), env.runtime.artifactsDir)));

app.get("/health", (_req, res) => {
  res.json({
    service: env.runtime.serviceName,
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

app.use(env.runtime.analysisApiRoute, analysisRouter);
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
