import { defineDoc } from "@earendil-works/pi-durable";
import type { FileRecord } from "@reework/types";

/**
 * Durable, session-scoped record of files stored beside the agent's storage.
 * Bytes live in `<storagePath>.files/`, content-addressed by sha256; this doc is
 * the index that names them.
 */
export const FilesDoc = defineDoc<{ files: FileRecord[] }>({
  kind: "reework.files",
  version: 1,
  scope: "session",
  initial: () => ({ files: [] }),
});
