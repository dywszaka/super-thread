import { spawn, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const electronVite = join(root, "node_modules/electron-vite/bin/electron-vite.js");
const env = { ...process.env };

if (process.platform === "darwin") {
  const electronVersion = JSON.parse(readFileSync(join(root, "node_modules/electron/package.json"), "utf8")).version;
  const source = join(root, "node_modules/electron/dist/Electron.app");
  const branded = join(root, "node_modules/.cache/super-thread-electron", electronVersion, "Super Thread.app");
  const executable = join(branded, "Contents/MacOS/Super Thread");
  const ready = join(branded, ".super-thread-ready");

  if (!existsSync(ready)) {
    rmSync(branded, { recursive: true, force: true });
    mkdirSync(dirname(branded), { recursive: true });
    execFileSync("cp", ["-cR", source, branded]);
    renameSync(join(branded, "Contents/MacOS/Electron"), executable);
    const plist = join(branded, "Contents/Info.plist");
    for (const [key, value] of [
      ["CFBundleDisplayName", "Super Thread"],
      ["CFBundleName", "Super Thread"],
      ["CFBundleExecutable", "Super Thread"],
      ["CFBundleIdentifier", "com.superthread.desktop.dev"],
      ["CFBundleIconFile", "icon.icns"]
    ]) execFileSync("plutil", ["-replace", key, "-string", value, plist]);
    writeFileSync(ready, "");
  }

  copyFileSync(join(root, "build/icon.icns"), join(branded, "Contents/Resources/icon.icns"));
  copyFileSync(join(root, "src/renderer/src/assets/icon.png"), join(branded, "Contents/Resources/icon.png"));
  env.ELECTRON_EXEC_PATH = executable;
}

const child = spawn(process.execPath, [electronVite, "dev"], { cwd: root, env, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
