import { extractorConfigurationFromEnvironment } from "./config.js";
import { configuredExtractionRunner } from "./configured-runner.js";
import { JsonLineLogger } from "./logger.js";
import { createDocumentExtractorService } from "./service.js";

const logger = new JsonLineLogger();

async function main(): Promise<void> {
  const configuration = extractorConfigurationFromEnvironment();
  const service = createDocumentExtractorService(configuration, {
    extractionRunner: configuredExtractionRunner(configuration),
    logger,
  });
  await service.listen();

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void service.close().then(() => {
      process.exitCode = 0;
    }).catch(() => {
      logger.error("shutdown_failed", { code: "shutdown_failed" });
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

await main().catch(() => {
  logger.error("startup_failed", { code: "startup_failed" });
  process.exitCode = 1;
});
