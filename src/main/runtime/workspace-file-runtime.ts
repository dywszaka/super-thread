import { constants } from "node:fs";
import { open, realpath, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { DeviceConnection, WorkspaceFileEntry, WorkspaceFileLocation } from "../../shared/domain";
import { MAX_PREVIEW_FILE_BYTES, previewFileType } from "../../shared/file-preview";
import { quoteShellArgument } from "./login-shell";
import { BinaryProcessRunner, type BinaryCommandRunner } from "./binary-command-runner";

// Sent over SSH, never installed on the device. JSON stdin keeps filenames out of shell syntax.
export const remoteFileHelper = String.raw`
import os, sys, json, stat
try:
    q = json.load(sys.stdin)
    logical_root = os.path.abspath(os.path.expanduser(q['root']))
    root = os.path.realpath(logical_root)
    candidate = os.path.abspath(os.path.join(logical_root, q['path']))
    path = os.path.realpath(candidate)
    if (os.path.commonpath([logical_root, candidate]) != logical_root and os.path.commonpath([root, candidate]) != root) or os.path.commonpath([root, path]) != root:
        raise ValueError('Path must remain inside this workspace')
    def entry(p, name):
        actual = os.path.realpath(p)
        if os.path.commonpath([root, actual]) != root: return None
        s = os.stat(actual)
        kind = 'directory' if stat.S_ISDIR(s.st_mode) else 'file' if stat.S_ISREG(s.st_mode) else None
        ext = os.path.splitext(actual)[1].lower()
        filetype = {'.pdf':'pdf','.html':'html','.htm':'html','.md':'markdown','.markdown':'markdown'}.get(ext)
        if kind is None: return None
        e = dict(name=name, path=os.path.relpath(actual, root), kind=kind)
        if filetype: e['fileType'] = filetype
        return e
    if q['mode'] == 'read':
        fd = os.open(path, os.O_RDONLY | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as f:
            s = os.fstat(f.fileno())
            after = os.stat(path)
            if os.path.commonpath([root, os.path.realpath(path)]) != root or (s.st_dev,s.st_ino) != (after.st_dev,after.st_ino):
                raise ValueError('File changed during access; retry')
            if not stat.S_ISREG(s.st_mode): raise ValueError('Only regular files can be previewed')
            if s.st_size > q['maxBytes']: raise ValueError('File exceeds the size limit')
            data = f.read(q['maxBytes'] + 1)
            if len(data) > q['maxBytes']: raise ValueError('File exceeds the size limit')
            sys.stdout.buffer.write(data)
    else:
        result = entry(path, os.path.basename(path))
        if result is None: raise ValueError('Only directories and regular files are supported')
        if result['kind'] == 'directory':
            entries = []
            with os.scandir(path) as items:
                for i, item in enumerate(items):
                    if i >= 10000: raise ValueError('Directory has more than 10000 entries; enter a more specific path')
                    try: e = entry(item.path, item.name)
                    except OSError: continue
                    if e and (e['kind'] == 'directory' or e.get('fileType')): entries.append(e)
            result['entries'] = sorted(entries, key=lambda e: (e['kind'] != 'directory', e['name'].lower()))
            result['parentPath'] = None if path == root else os.path.relpath(os.path.dirname(path), root)
        print(json.dumps(result))
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(1)
`;

export class WorkspaceFileRuntime {
  constructor(private readonly root: string, private readonly connection: DeviceConnection,
    private readonly runner: BinaryCommandRunner = new BinaryProcessRunner()) {}

  private async localPath(input: string): Promise<{ root: string; path: string; relativePath: string }> {
    if (input.includes("\0")) throw new Error("Invalid file path");
    const expanded = this.root === "~" ? homedir() : this.root.startsWith("~/") ? join(homedir(), this.root.slice(2)) : this.root;
    const root = await realpath(expanded);
    const logicalRoot = resolve(expanded);
    const candidate = resolve(logicalRoot, input);
    try { this.assertInside(logicalRoot, candidate); }
    catch { this.assertInside(root, candidate); }
    const path = await realpath(candidate);
    this.assertInside(root, path);
    return { root, path, relativePath: relative(root, path) || "." };
  }

  private assertInside(root: string, path: string): void {
    const rel = relative(root, path);
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) throw new Error("Path must remain inside this workspace");
  }

  private remote(mode: "inspect" | "read", path: string, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
    const { host, user, port } = this.connection.config;
    if (!host) throw new Error("SSH host is missing");
    const args = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5"];
    if (port) args.push("-p", String(port));
    args.push("--", user ? `${user}@${host}` : host, `python3 -c ${quoteShellArgument(remoteFileHelper)}`);
    return this.runner.run("ssh", args, { input: JSON.stringify({ root: this.root, path, mode, maxBytes }), maxBytes, signal });
  }

  async inspect(input: string, signal?: AbortSignal): Promise<WorkspaceFileLocation> {
    if (signal?.aborted) throw new Error("File request cancelled");
    if (this.connection.transport === "ssh") return JSON.parse((await this.remote("inspect", input, 8 * 1024 * 1024, signal)).toString());
    const { root, path, relativePath } = await this.localPath(input);
    const info = await stat(path);
    const fileType = previewFileType(path);
    if (info.isFile()) return { name: path.split(sep).at(-1)!, path: relativePath, kind: "file", fileType };
    if (!info.isDirectory()) throw new Error("Only directories and regular files are supported");
    const children = await readdir(path);
    if (children.length > 10000) throw new Error("Directory has more than 10000 entries; enter a more specific path");
    const entries: WorkspaceFileEntry[] = [];
    for (const name of children) {
      try {
        const resolved = await this.localPath(relative(root, join(path, name)));
        const child = await stat(resolved.path);
        const type = previewFileType(resolved.path);
        if (child.isDirectory() || (child.isFile() && type)) entries.push({ name, path: resolved.relativePath, kind: child.isDirectory() ? "directory" : "file", fileType: type });
      } catch { /* Broken, inaccessible, and out-of-root links cannot be selected. */ }
    }
    entries.sort((a, b) => Number(a.kind !== "directory") - Number(b.kind !== "directory") || a.name.localeCompare(b.name));
    return { name: path.split(sep).at(-1)!, path: relativePath, kind: "directory", entries, parentPath: path === root ? null : relative(root, resolve(path, "..")) || "." };
  }

  async read(input: string, maxBytes = MAX_PREVIEW_FILE_BYTES, signal?: AbortSignal): Promise<Buffer> {
    if (signal?.aborted) throw new Error("File request cancelled");
    if (this.connection.transport === "ssh") return this.remote("read", input, maxBytes, signal);
    const { root, path } = await this.localPath(input);
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      const currentPath = await realpath(path);
      this.assertInside(root, currentPath);
      const current = await stat(currentPath);
      if (info.ino !== current.ino || info.dev !== current.dev) throw new Error("File changed during access; retry");
      if (!info.isFile()) throw new Error("Only regular files can be previewed");
      if (info.size > maxBytes) throw new Error("File exceeds the size limit");
      const chunks: Buffer[] = [];
      let size = 0;
      while (size <= maxBytes) {
        if (signal?.aborted) throw new Error("File request cancelled");
        const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - size));
        const { bytesRead } = await file.read(chunk);
        if (!bytesRead) break;
        size += bytesRead;
        chunks.push(chunk.subarray(0, bytesRead));
      }
      if (size > maxBytes) throw new Error("File exceeds the size limit");
      return Buffer.concat(chunks, size);
    } finally { await file.close(); }
  }
}
