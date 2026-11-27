import { z } from "zod";
import { quoteShellArgument } from "./login-shell";
import { codexRecordingScript } from "./codex-recording-script";
import type { DeviceConnection } from "../../shared/domain";
import { DeviceCommandRunner } from "./command-runner";

export const CODEX_FRAME_PREFIX = "\x1b]777;superthread-codex;";
const eventSchema = z.object({
  token: z.string().regex(/^[a-f0-9]{48}$/),
  id: z.string().regex(/^[A-Za-z0-9_-]{1,160}$/),
  event: z.enum(["SessionStart", "UserPromptSubmit"]),
  cwd: z.string().max(8192),
  title: z.string().max(320).optional()
}).strict();
export type CodexRecordingEvent = Omit<z.infer<typeof eventSchema>, "token"> & { terminalId: string };

export function codexRecordingCommand(mode: "install" | "bootstrap", token?: string): string {
  const source = Buffer.from(codexRecordingScript).toString("base64");
  const loader = `import base64; _source=base64.b64decode('${source}'); exec(compile(_source, '<superthread-codex>', 'exec'))`;
  const command = `python3 -c ${quoteShellArgument(loader)} ${mode}${token ? ` ${quoteShellArgument(token)}` : ""}`;
  // Missing Python must leave a normal usable shell, including on remote devices.
  return mode === "install" ? command : `if command -v python3 >/dev/null 2>&1; then exec ${command}; else echo '[SuperThread] Codex recording requires Python 3.' >&2; exec "\${SHELL:-/bin/sh}" -l; fi`;
}

export interface CodexRecordingInstaller { install(connection: DeviceConnection): Promise<string>; }
export class DeviceCodexRecordingInstaller implements CodexRecordingInstaller {
  async install(connection: DeviceConnection): Promise<string> {
    const result = await new DeviceCommandRunner(connection).run("sh", ["-c", codexRecordingCommand("install")], { timeoutMs: 12_000 });
    return result.stdout;
  }
}

/** Incremental OSC decoder: metadata never enters xterm or terminal replay. */
export class CodexRecordingDecoder {
  private pending = "";
  constructor(private readonly token: string, private readonly emit: (event: Omit<CodexRecordingEvent, "terminalId">) => void) {}

  feed(chunk: string): string {
    this.pending += chunk;
    let output = "";
    for (;;) {
      const start = this.pending.indexOf(CODEX_FRAME_PREFIX);
      if (start < 0) {
        let keep = Math.min(this.pending.length, CODEX_FRAME_PREFIX.length - 1);
        while (keep > 0 && !CODEX_FRAME_PREFIX.startsWith(this.pending.slice(-keep))) keep--;
        output += this.pending.slice(0, this.pending.length - keep);
        this.pending = this.pending.slice(this.pending.length - keep);
        return output;
      }
      output += this.pending.slice(0, start);
      this.pending = this.pending.slice(start);
      const end = this.pending.indexOf("\x07", CODEX_FRAME_PREFIX.length);
      if (end < 0) {
        // Abandon a malformed frame rather than indefinitely hiding later output.
        if (this.pending.length > 16_384) this.pending = "";
        return output;
      }
      const encoded = this.pending.slice(CODEX_FRAME_PREFIX.length, end);
      this.pending = this.pending.slice(end + 1);
      if (encoded.length > 16_384 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) continue;
      try {
        const result = eventSchema.safeParse(JSON.parse(Buffer.from(encoded, "base64").toString("utf8")));
        if (result.success && result.data.token === this.token) {
          const { token: _token, ...event } = result.data;
          this.emit(event);
        }
      } catch { /* Malformed terminal metadata must not affect the terminal. */ }
    }
  }
}
