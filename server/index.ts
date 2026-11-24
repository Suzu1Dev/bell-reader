import { resolve } from "node:path";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ReaderStore } from "./store.js";

const config = loadConfig();
const dbPath = resolve(config.dataDir, "bell-reader.sqlite");
const store = new ReaderStore(dbPath);

const app = createApp({
  store,
  dataDir: config.dataDir,
  allowedOrigins: config.allowedOrigins,
  suiteLinks: config.suiteLinks,
  suiteFetch: config.suiteFetch,
});

const server = app.listen(config.port, config.host, () => {
  console.log(`BELL Web Reader listening on http://${config.host}:${config.port}`);
});

const shutdown = () => {
  server.close(() => {
    store.close();
    process.exit(0);
  });
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
