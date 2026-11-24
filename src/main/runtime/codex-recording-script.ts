/** Installed only in the device user's home; never in project repositories. */
export const codexRecordingScript = String.raw`
import base64, fcntl, json, os, re, select, shlex, shutil, stat, subprocess, sys, tempfile
from pathlib import Path

VERSION = "1"
ROOT = Path.home() / ".superthread" / "integrations" / "codex"
HELPER = ROOT / "collector.py"
PREFIX = "\x1b]777;superthread-codex;"

def atomic(path, text, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(dir=str(path.parent), prefix=".superthread-")
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, "w") as stream:
            stream.write(text)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)

def install():
    ROOT.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Serialize installs from simultaneous Terminal starts on this device.
    with (ROOT / "install.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        source = globals().get("_source")
        if source:
            atomic(HELPER, source.decode("utf-8"))
        codex_home = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
        hooks_path = codex_home / "hooks.json"
        data = json.loads(hooks_path.read_text()) if hooks_path.exists() else {}
        if not isinstance(data, dict) or not isinstance(data.get("hooks", {}), dict):
            raise ValueError("Existing Codex hooks.json is not an object; left unchanged")
        hooks = data.setdefault("hooks", {})
        command = shlex.quote(sys.executable) + " " + shlex.quote(str(HELPER)) + " hook"
        for event in ("SessionStart", "UserPromptSubmit"):
            groups = hooks.setdefault(event, [])
            if not isinstance(groups, list):
                raise ValueError("Existing Codex hook event is not an array; left unchanged")
            # Own only entries carrying our exact identifier, preserving every user hook.
            groups[:] = [g for g in groups if not (isinstance(g, dict) and len(g.get("hooks", [])) == 1 and isinstance(g["hooks"][0], dict) and g["hooks"][0].get("command") == command)]
            groups.append({"hooks": [{"type": "command", "command": command, "timeout": 2}]})
        updated = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
        if not hooks_path.exists() or hooks_path.read_text() != updated:
            if hooks_path.exists():
                atomic(hooks_path.with_name("hooks.json.superthread-backup"), hooks_path.read_text())
            atomic(hooks_path, updated)
        # Zsh startup files preserve the user's normal login/interactive startup order.
        zsh_dir = ROOT / "zsh"
        for name in (".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"):
            content = 'ZDOTDIR="$SUPERTHREAD_USER_ZDOTDIR"\n'
            content += '[ ! -r "$ZDOTDIR/' + name + '" ] || source "$ZDOTDIR/' + name + '"\n'
            content += 'export SUPERTHREAD_USER_ZDOTDIR="$ZDOTDIR"\n'
            if name == ".zshrc":
                content += 'function codex { command "$SUPERTHREAD_PYTHON" "$SUPERTHREAD_COLLECTOR" launch "$@"; }\n'
            if name != ".zlogin" and name != ".zlogout":
                content += 'ZDOTDIR="$SUPERTHREAD_ZSH_DIR"\n'
            atomic(zsh_dir / name, content)

def bootstrap(token):
    shell = os.environ.get("SHELL", "/bin/sh")
    try:
        install()
        name = Path(shell).name
        if name not in ("bash", "zsh"):
            raise ValueError("Codex recording supports bash and zsh terminals")
        os.environ["SUPERTHREAD_TERMINAL_TOKEN"] = token
        os.environ["SUPERTHREAD_TERMINAL_TTY"] = os.ttyname(0)
        os.environ["SUPERTHREAD_PYTHON"] = sys.executable
        os.environ["SUPERTHREAD_COLLECTOR"] = str(HELPER)
        if name == "zsh":
            os.environ["SUPERTHREAD_USER_ZDOTDIR"] = os.environ.get("ZDOTDIR", str(Path.home()))
            os.environ["SUPERTHREAD_ZSH_DIR"] = str(ROOT / "zsh")
            os.environ["ZDOTDIR"] = str(ROOT / "zsh")
            os.execv(shell, [shell, "-l"])
        # Import just this function, keeping Bash's genuine login-shell startup
        # and avoiding sourcing .bashrc twice via a user's .bash_profile.
        os.environ["BASH_FUNC_codex%%"] = '() { command "$SUPERTHREAD_PYTHON" "$SUPERTHREAD_COLLECTOR" launch "$@"; }'
        os.execv(shell, [shell, "-l"])
    except Exception as error:
        print("[SuperThread] Codex recording unavailable: " + str(error), file=sys.stderr)
        os.execv(shell, [shell, "-l"])

def launch(args):
    # Shell startup may select a custom CODEX_HOME after Terminal bootstrap.
    try:
        install()
    except Exception as error:
        print("[SuperThread] Could not configure Codex hooks: " + str(error), file=sys.stderr)
    executable = shutil.which("codex")
    if not executable:
        print("codex: command not found", file=sys.stderr)
        return 127
    environment = os.environ.copy()
    environment.pop("SUPERTHREAD_CODEX_TOKEN", None)
    # The shared daemon can have another terminal's environment. Keep the hook
    # context inside this CLI process rather than attributing by cwd or daemon PID.
    try:
        help_text = subprocess.run([executable, "--help"], capture_output=True, text=True, timeout=5).stdout
    except (OSError, subprocess.SubprocessError):
        help_text = ""
    passthrough = {"agents", "app", "app-server", "remote-control", "login", "logout", "mcp", "plugin", "update", "doctor", "completion", "features", "help", "debug", "cloud", "sandbox", "queue", "archive", "delete", "unarchive", "migrate-rollouts", "apply", "exec-server"}
    value_options = {"-c", "--config", "-p", "--profile", "-m", "--model", "-C", "--cd", "-s", "--sandbox", "-a", "--ask-for-approval", "-i", "--image", "--add-dir", "--enable", "--disable", "--local-provider", "--remote-auth-token-env"}
    command = None
    external = False
    skip = False
    for arg in args:
        if skip:
            skip = False
            continue
        if arg == "--":
            break
        if arg == "--remote" or arg.startswith("--remote="):
            external = True
        if arg in value_options:
            skip = True
        elif not arg.startswith("-") and command is None:
            command = arg
    special = command in passthrough
    if not special and not external:
        if "--no-daemon" in help_text:
            if "--no-daemon" not in args:
                args = ["--no-daemon"] + args
            environment["SUPERTHREAD_CODEX_TOKEN"] = environment.get("SUPERTHREAD_TERMINAL_TOKEN", "")
            environment["SUPERTHREAD_CODEX_TTY"] = environment.get("SUPERTHREAD_TERMINAL_TTY", "")
        elif "--no-daemon" not in help_text:
            print("[SuperThread] Update Codex to a version supporting --no-daemon for session recording.", file=sys.stderr)
            environment.pop("SUPERTHREAD_CODEX_TOKEN", None)
    else:
        environment.pop("SUPERTHREAD_CODEX_TOKEN", None)
    os.execve(executable, [executable] + args, environment)

def hook():
    token = os.environ.get("SUPERTHREAD_CODEX_TOKEN", "")
    tty = os.environ.get("SUPERTHREAD_CODEX_TTY", "")
    if not re.fullmatch(r"[a-f0-9]{48}", token) or not tty.startswith("/dev/"):
        return
    data = json.loads(sys.stdin.read(1024 * 1024))
    session_id = data.get("session_id", "")
    if not isinstance(session_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,160}", session_id):
        return
    event = data.get("hook_event_name")
    if event not in ("SessionStart", "UserPromptSubmit"):
        return
    payload = {"token": token, "id": session_id, "event": event, "cwd": str(data.get("cwd", ""))[:4096]}
    if event == "UserPromptSubmit":
        payload["title"] = re.sub(r"\s+", " ", str(data.get("prompt", ""))).strip()[:160]
    frame = PREFIX + base64.b64encode(json.dumps(payload, ensure_ascii=False).encode()).decode() + "\x07"
    descriptor = os.open(tty, os.O_WRONLY | os.O_NOCTTY | os.O_NONBLOCK)
    try:
        if stat.S_ISCHR(os.fstat(descriptor).st_mode):
            pending = frame.encode()
            while pending and select.select([], [descriptor], [], 0.5)[1]:
                pending = pending[os.write(descriptor, pending):]
    finally:
        os.close(descriptor)

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode == "install":
        install()
        print("Installed. In Codex, open /hooks and trust the SuperThread hooks. Open a new Terminal to record sessions.")
    elif mode == "bootstrap":
        bootstrap(sys.argv[2])
    elif mode == "launch":
        sys.exit(launch(sys.argv[2:]) or 0)
    elif mode == "hook":
        # Recording must never block or add context to the user's Codex turn.
        try:
            hook()
        except Exception:
            pass
`;
