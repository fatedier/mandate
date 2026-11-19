import * as os from "node:os";
import * as path from "node:path";
import type { MandateModule } from "../module.js";
import { mountFileRoutes } from "./file-routes.js";
import { mountShareFileRoutes } from "./share-file-save.js";

/** Files agents link in their replies, opened in the page; and what the
 *  user shares from a conversation, saved for the desktop app. */
export const filesModule: MandateModule = {
  id: "files",
  mountRoutes: (app, { deps }) => {
    const downloadsDir = path.join(os.homedir(), "Downloads");
    mountFileRoutes(app, { projects: deps.projects, workers: deps.workers, downloadsDir });
    // What the user shares from a conversation, saved for the desktop app.
    mountShareFileRoutes(app, { downloadsDir });
  }
};
