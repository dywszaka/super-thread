/** Observes the TUI's unchanged WebSocket stream to the original shared daemon. */
export const codexRecordingRelay = String.raw`
import signal, socket, socketserver, subprocess, threading

MAX_RPC_BYTES = 64 * 1024 * 1024

class ConversationObserver:
    def __init__(self, emit):
        self.emit = emit
        self.pending = {}
        self.threads = {}
        self.lock = threading.Lock()

    def observe(self, payload, outgoing):
        # Recording is advisory: unknown protocol versions still pass through.
        try:
            message = json.loads(payload)
            if not isinstance(message, dict):
                return
            with self.lock:
                self.message(message, outgoing)
        except Exception:
            pass

    def message(self, message, outgoing):
        request_id = message.get("id")
        if type(request_id) not in (str, int):
            return
        key = (type(request_id), request_id)
        if outgoing:
            method = message.get("method")
            params = message.get("params")
            if not isinstance(params, dict):
                return
            if method in ("thread/start", "thread/resume", "thread/fork"):
                context = (method, None, None)
            elif method in ("turn/start", "turn/steer") and params.get("threadId") in self.threads:
                # Retain only a bounded summary, never the input array or history.
                parts = []
                for item in params.get("input", []):
                    if isinstance(item, dict) and item.get("type") == "text" and isinstance(item.get("text"), str):
                        parts.append(item["text"][:640])
                        if sum(map(len, parts)) >= 640:
                            break
                title = re.sub(r"\s+", " ", " ".join(parts)).strip()[:160]
                context = (method, params["threadId"], title)
            else:
                return
            if len(self.pending) >= 1024:
                self.pending.pop(next(iter(self.pending)))
            self.pending[key] = context
            return
        # Notifications, server requests and unrelated clients cannot establish ownership.
        if "method" in message:
            return
        context = self.pending.pop(key, None)
        result = message.get("result")
        if context is None or "error" in message or not isinstance(result, dict):
            return
        method, thread_id, title = context
        if method.startswith("thread/"):
            thread = result.get("thread")
            if not isinstance(thread, dict):
                return
            thread_id, cwd = thread.get("id"), thread.get("cwd")
            if not isinstance(thread_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", thread_id) or not isinstance(cwd, str):
                return
            if len(self.threads) >= 256 and thread_id not in self.threads:
                self.threads.pop(next(iter(self.threads)))
            self.threads[thread_id] = cwd[:4096]
            self.emit(thread_id, "SessionStart", cwd[:4096], None)
        elif thread_id in self.threads:
            if method == "turn/start" and not isinstance(result.get("turn"), dict):
                return
            if method == "turn/steer" and not isinstance(result.get("turnId"), str):
                return
            self.emit(thread_id, "UserPromptSubmit", self.threads[thread_id], title)

class WebSocketObserver:
    def __init__(self, observer, outgoing):
        self.observer, self.outgoing = observer, outgoing
        self.pending = bytearray()
        self.fragment = None
        self.upgraded = False
        self.enabled = True

    def disable(self):
        self.enabled = False
        self.pending.clear()
        self.fragment = None

    def feed(self, chunk):
        # Only inspect a copy. Unsupported framing disables observation, never forwarding.
        if not self.enabled:
            return
        self.pending.extend(chunk)
        if not self.upgraded:
            end = self.pending.find(b"\r\n\r\n")
            if end < 0:
                if len(self.pending) > 16384:
                    self.disable()
                return
            if end > 16384 or not self.pending.startswith(b"GET " if self.outgoing else b"HTTP/1.1 101 "):
                self.disable()
                return
            del self.pending[:end + 4]
            self.upgraded = True
        while len(self.pending) >= 2:
            first, second = self.pending[:2]
            final, opcode, masked = bool(first & 0x80), first & 0xf, bool(second & 0x80)
            if first & 0x70 or masked != self.outgoing or opcode not in (0, 1, 2, 8, 9, 10):
                self.disable()
                return
            size, offset = second & 0x7f, 2
            extra = 2 if size == 126 else 8 if size == 127 else 0
            if len(self.pending) < offset + extra:
                return
            if extra:
                size = int.from_bytes(self.pending[offset:offset + extra], "big")
                offset += extra
            if size > MAX_RPC_BYTES:
                self.disable()
                return
            if masked:
                offset += 4
            if len(self.pending) < offset + size:
                return
            payload = bytes(self.pending[offset:offset + size])
            if masked:
                mask = self.pending[offset - 4:offset]
                payload = bytes(value ^ mask[index % 4] for index, value in enumerate(payload))
            del self.pending[:offset + size]
            if opcode >= 8:
                continue
            if opcode == 2 or (opcode == 0 and self.fragment is None) or (opcode == 1 and self.fragment is not None):
                self.disable()
                return
            if opcode == 1:
                self.fragment = bytearray()
            self.fragment.extend(payload)
            if len(self.fragment) > MAX_RPC_BYTES:
                self.disable()
                return
            if final:
                self.observer.observe(self.fragment, self.outgoing)
                self.fragment = None

class RecordingRelay(socketserver.ThreadingUnixStreamServer):
    daemon_threads = False
    block_on_close = True

    def __init__(self, path, executable, environment, emit):
        self.executable, self.environment, self.emit = executable, environment, emit
        self.active = set()
        self.active_lock = threading.Lock()
        self.emit_lock = threading.Lock()
        self.stopping = False
        super().__init__(path, RecordingRelayConnection)
        os.chmod(path, 0o600)

    def stop(self):
        self.shutdown()
        with self.active_lock:
            self.stopping = True
            for connection in list(self.active):
                connection.close()
        self.server_close()

    def record(self, *event):
        with self.emit_lock:
            self.emit(*event)

class RecordingRelayConnection(socketserver.BaseRequestHandler):
    def close(self):
        try:
            self.request.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass
        upstream = getattr(self, "upstream", None)
        if upstream is not None and upstream.poll() is None:
            try:
                upstream.terminate()
            except OSError:
                pass

    def handle(self):
        self.upstream = None
        with self.server.active_lock:
            if self.server.stopping:
                self.close()
                return
            self.server.active.add(self)
        try:
            # This attaches to the existing daemon. Terminating the proxy never stops it.
            self.upstream = subprocess.Popen([self.server.executable, "app-server", "proxy"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=self.server.environment)
            observer = ConversationObserver(self.server.record)
            outgoing, incoming = WebSocketObserver(observer, True), WebSocketObserver(observer, False)
            def receive():
                try:
                    while True:
                        chunk = os.read(self.upstream.stdout.fileno(), 65536)
                        if not chunk:
                            break
                        incoming.feed(chunk)
                        self.request.sendall(chunk)
                except (OSError, ValueError):
                    pass
                finally:
                    self.close()
            receiver = threading.Thread(target=receive, daemon=True)
            receiver.start()
            while True:
                chunk = self.request.recv(65536)
                if not chunk:
                    break
                outgoing.feed(chunk)
                self.upstream.stdin.write(chunk)
                self.upstream.stdin.flush()
        except (OSError, ValueError, EOFError):
            pass
        finally:
            self.close()
            if self.upstream is not None:
                try:
                    self.upstream.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self.upstream.kill()
                    self.upstream.wait()
                self.upstream.stdin.close()
                self.upstream.stdout.close()
            with self.server.active_lock:
                self.server.active.discard(self)

def launch_shared(executable, args, environment, token, tty):
    # Probe before starting any CLI session. Unsupported versions run unchanged.
    try:
        probe = subprocess.run([executable, "app-server", "proxy", "--help"], capture_output=True, timeout=5, env=environment)
        if probe.returncode != 0 or b"--sock" not in probe.stdout:
            return None
        started = subprocess.run([executable, "app-server", "daemon", "start"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=15, env=environment)
        if started.returncode != 0:
            return None
    except (OSError, subprocess.SubprocessError):
        return None
    directory = None
    relay = None
    try:
        directory = tempfile.TemporaryDirectory(prefix="st-codex-", dir="/tmp")
        path = str(Path(directory.name) / "rpc.sock")
        relay = RecordingRelay(path, executable, environment, lambda session_id, event, cwd, title: emit_metadata(token, tty, session_id, event, cwd, title))
        server = threading.Thread(target=relay.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        server.start()
    except (OSError, RuntimeError):
        if relay is not None:
            relay.server_close()
        if directory is not None:
            directory.cleanup()
        return None
    with directory:
        child = None
        previous = {}
        try:
            try:
                child = subprocess.Popen([executable, "--remote", "unix://" + path] + args, env=environment)
            except OSError:
                return None
            # Both processes remain in the terminal's foreground group. Let the TUI
            # handle Ctrl+C; forward termination without ever signalling the daemon.
            previous[signal.SIGINT] = signal.signal(signal.SIGINT, lambda *_: None)
            def forward_signal(number, _):
                try:
                    child.send_signal(number)
                except OSError:
                    pass
            for sig in (signal.SIGTERM, signal.SIGHUP):
                previous[sig] = signal.signal(sig, forward_signal)
            return child.wait()
        finally:
            if child is not None and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            for sig, handler in previous.items():
                signal.signal(sig, handler)
            relay.stop()
            server.join(timeout=2)
`;
