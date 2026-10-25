import { spawn } from "node:child_process";

export interface BinaryCommandOptions {
  input?: string;
  maxBytes: number;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface BinaryCommandRunner {
  run(program: string, args: string[], options: BinaryCommandOptions): Promise<Buffer>;
}

/** A bounded byte channel; terminal/text command output must never carry file bytes. */
export class BinaryProcessRunner implements BinaryCommandRunner {
  run(program: string, args: string[], options: BinaryCommandOptions): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted) { reject(new Error("File request cancelled")); return; }
      const child = spawn(program, args, { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      let size = 0, stderr = "", done = false;
      const finish = (error?: Error): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        if (error) {
          child.kill("SIGKILL");
          reject(error);
        } else resolve(Buffer.concat(chunks, size));
      };
      const abort = (): void => finish(new Error("File request cancelled"));
      const timer = setTimeout(() => finish(new Error("File request timed out. Check the SSH connection and retry.")), options.timeoutMs ?? 30_000);
      options.signal?.addEventListener("abort", abort, { once: true });
      child.stdout.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > options.maxBytes) finish(new Error(`File exceeds the ${Math.floor(options.maxBytes / 1024 / 1024)} MiB limit`));
        else if (!done) chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); });
      child.stdin.on("error", () => { /* A failed SSH connection may close stdin first. */ });
      child.once("error", finish);
      child.once("close", (code) => finish(code === 0 ? undefined : new Error(code === 127 && stderr.includes("python3")
        ? "Python 3 is required on this device to preview files. Install python3 and retry."
        : stderr.trim() || `${program} exited with ${code}`)));
      child.stdin.end(options.input);
    });
  }
}
