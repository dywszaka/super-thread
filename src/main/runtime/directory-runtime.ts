import { homedir } from "node:os";
import { dirname, join, posix } from "node:path";
import type { Device, DeviceConnection, DirectoryListing } from "../../shared/domain";
import { DeviceCommandRunner, type CommandRunner } from "./command-runner";

export class DirectoryRuntime {
  private readonly runner: CommandRunner;

  constructor(private readonly device: Device, connection: DeviceConnection, runner?: CommandRunner) {
    this.runner = runner ?? new DeviceCommandRunner(connection);
  }

  async list(path?: string): Promise<DirectoryListing> {
    const cwd = await this.resolveCwd(path);
    const resolved = await this.runner.run("pwd", [], { cwd, timeoutMs: 15_000 }).then((result) => result.stdout);
    const output = await this.runner.run("find", [".", "-mindepth", "1", "-maxdepth", "1", "-type", "d", "-print"], { cwd: resolved, timeoutMs: 20_000 }).then((result) => result.stdout);
    const names = output.split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^\.\//, ""))
      .filter((name) => name.length > 0 && !name.includes("/"))
      .sort((left, right) => left.localeCompare(right));
    const joinPath = this.device.type === "remote" ? posix.join : join;
    return {
      deviceId: this.device.id,
      path: resolved,
      parentPath: this.parentPath(resolved),
      entries: names.map((name) => ({ name, path: joinPath(resolved, name) }))
    };
  }

  private async resolveCwd(path?: string): Promise<string | undefined> {
    const value = path?.trim();
    if (!value) return this.device.type === "remote" ? undefined : homedir();
    if (this.device.type === "local") {
      if (value === "~") return homedir();
      if (value.startsWith("~/")) return join(homedir(), value.slice(2));
      return value;
    }
    if (value === "~") return undefined;
    if (value.startsWith("~/")) {
      const home = await this.runner.run("pwd", [], { timeoutMs: 15_000 }).then((result) => result.stdout);
      return posix.join(home, value.slice(2));
    }
    return value;
  }

  private parentPath(path: string): string | null {
    const parent = this.device.type === "remote" ? posix.dirname(path) : dirname(path);
    return parent === path ? null : parent;
  }
}
