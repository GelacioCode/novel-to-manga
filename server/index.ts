import { createApp } from "./app";
import { config } from "./config";
import { getDb } from "./db";

createApp(getDb()).listen(config.apiPort, "127.0.0.1", () => console.log(`Novel to Manga API: http://127.0.0.1:${config.apiPort}`));
