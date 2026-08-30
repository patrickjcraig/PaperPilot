import { configuredInspectionRunners } from "./configured-runners.js";
import { validatorConfigurationFromEnvironment } from "./config.js";
import { JsonLineLogger } from "./logger.js";
import { createDocumentValidatorService } from "./service.js";

const logger = new JsonLineLogger();

async function main(): Promise<void> {
  const configuration = validatorConfigurationFromEnvironment();
  const runners = configuredInspectionRunners(configuration);
  const service = createDocumentValidatorService(configuration, {
    ...runners,
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
  // Configuration, bind, and runner details may contain sensitive local paths;
  // startup failures therefore use one fixed operator-visible event.
  logger.error("startup_failed", { code: "startup_failed" });
  process.exitCode = 1;
});
