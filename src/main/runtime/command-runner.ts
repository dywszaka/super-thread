import { spawn } from "node:child_process";
import type { CommandResult, DeviceConnection } from "../../shared/domain";

export interface CommandRunner {
  run(program: string, args: string[], options?: { cwd?: string; timeoutMs?: number }): Promise<CommandResult>;
}

export class ProcessCommandRunner implements CommandRunner {
  run(program: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(program, args, { cwd: options.cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 120_000);
      child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
      child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", (code) => {
        clearTimeout(timer);
        const result = { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1 };
        if (result.exitCode === 0) resolve(result);
        else reject(new Error(result.stderr || `${program} exited with ${result.exitCode}`));
      });
    });
  }
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

export class DeviceCommandRunner implements CommandRunner {
  constructor(
    private readonly connection: DeviceConnection,
    private readonly processRunner: CommandRunner = new ProcessCommandRunner()
  ) {}

  run(program: string, args: string[], options: { cwd?: string; timeoutMs?: number } = {}): Promise<CommandResult> {
    if (this.connection.transport === "local") return this.processRunner.run(program, args, options);
    const config = this.connection.config;
    const target = config.user ? `${config.user}@${config.host}` : String(config.host);
    const remote = `${options.cwd ? `cd ${quote(options.cwd)} && ` : ""}${[program, ...args].map(quote).join(" ")}`;
    const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
    if (config.port) sshArgs.push("-p", String(config.port));
    sshArgs.push(target, remote);
    return this.processRunner.run("ssh", sshArgs, { timeoutMs: options.timeoutMs });
  }
}
