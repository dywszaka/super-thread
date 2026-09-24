import { join } from "node:path";

const USER_DATA_DIRECTORY = "super-thread";

export function applicationUserDataPath(appDataPath: string): string {
  return join(appDataPath, USER_DATA_DIRECTORY);
}
