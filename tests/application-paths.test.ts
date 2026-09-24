import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { applicationUserDataPath } from "../src/main/application-paths";

test("development and packaged builds use the stable application data directory", () => {
  const appDataPath = join("Users", "example", "Library", "Application Support");

  assert.equal(applicationUserDataPath(appDataPath), join(appDataPath, "super-thread"));
});
