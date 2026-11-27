#!/usr/bin/env python3
"""A daemon proxy and a TUI client fixture; no network or Codex account needed."""
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import time


def read_exact(stream, size):
    result = bytearray()
    while len(result) < size:
        chunk = stream.read(size - len(result))
        if not chunk:
            raise EOFError()
        result.extend(chunk)
    return bytes(result)


def frame(payload, opcode=1):
    size = len(payload)
    header = bytes((128 | opcode, size)) if size < 126 else bytes((128 | opcode, 126)) + struct.pack("!H", size)
    return header + payload


args = sys.argv[1:]
if args == ["app-server", "proxy", "--help"]:
    print("--sock <SOCKET_PATH>")
elif args == ["app-server", "daemon", "start"]:
    pass
elif args == ["app-server", "proxy"]:
    if os.environ.get("RELAY_AUDIT"):
        with open(os.environ["RELAY_AUDIT"], "a") as audit:
            audit.write(json.dumps({"proxyPid": os.getpid()}) + "\n")
    stream = sys.stdin.buffer
    header = bytearray()
    while not header.endswith(b"\r\n\r\n"):
        header.extend(read_exact(stream, 1))
    key = next(line.split(b":", 1)[1].strip() for line in header.split(b"\r\n") if line.lower().startswith(b"sec-websocket-key:"))
    accept = base64.b64encode(hashlib.sha1(key + b"258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest())
    sys.stdout.buffer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + b"\r\n\r\n")
    sys.stdout.buffer.flush()
    fragmented = bytearray()
    while True:
        first, second = read_exact(stream, 2)
        size = second & 127
        if size == 126:
            size = struct.unpack("!H", read_exact(stream, 2))[0]
        mask = read_exact(stream, 4)
        data = read_exact(stream, size)
        data = bytes(value ^ mask[index % 4] for index, value in enumerate(data))
        opcode = first & 15
        if opcode in (8, 9):
            sys.stdout.buffer.write(frame(data, 8 if opcode == 8 else 10))
            sys.stdout.buffer.flush()
            if opcode == 8:
                break
            continue
        fragmented.extend(data)
        if not first & 128:
            continue
        request = json.loads(fragmented)
        fragmented.clear()
        method, params = request["method"], request.get("params", {})
        if method in ("thread/start", "thread/resume", "thread/fork"):
            thread_id = params["fixtureId"]
            result = {"thread": {"id": thread_id, "cwd": params.get("cwd", "/mock/daemon/home"), "turns": [{"text": "private transcript"}]}}
            sys.stdout.buffer.write(frame(json.dumps({"method": "thread/started", "params": {"thread": {"id": "foreign-thread", "cwd": "/same/shared/workspace"}}}).encode()))
        else:
            result = {"turn": {"id": "turn"}}
        sys.stdout.buffer.write(frame(json.dumps({"id": request["id"], "result": result}).encode()))
        sys.stdout.buffer.flush()
else:
    assert args[:1] == ["--remote"], args
    assert "--no-daemon" not in args
    assert "SUPERTHREAD_CODEX_TOKEN" not in os.environ
    path = args[1].removeprefix("unix://")
    if os.environ.get("RELAY_AUDIT"):
        with open(os.environ["RELAY_AUDIT"], "a") as audit:
            audit.write(json.dumps({"socket": path}) + "\n")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.connect(path)
        stream = client.makefile("rb")
        key = base64.b64encode(os.urandom(16))
        client.sendall(b"GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: " + key + b"\r\n\r\n")
        response = bytearray()
        while not response.endswith(b"\r\n\r\n"):
            response.extend(read_exact(stream, 1))
        assert response.startswith(b"HTTP/1.1 101")

        def receive():
            first, second = read_exact(stream, 2)
            size = second & 127
            if size == 126:
                size = struct.unpack("!H", read_exact(stream, 2))[0]
            elif size == 127:
                size = struct.unpack("!Q", read_exact(stream, 8))[0]
            return first & 15, read_exact(stream, size)

        def send(payload, opcode=1, final=True):
            mask = b"abcd"
            size = len(payload)
            header = bytes(((128 if final else 0) | opcode, 128 | size)) if size < 126 else bytes(((128 if final else 0) | opcode, 128 | 126)) + struct.pack("!H", size)
            client.sendall(header + mask + bytes(value ^ mask[index % 4] for index, value in enumerate(payload)))

        def rpc(request, fragmented=False):
            payload = json.dumps(request).encode()
            if fragmented:
                send(payload[:12], final=False)
                send(b"ping", 9)
                assert receive() == (10, b"ping")
                send(payload[12:], opcode=0)
            else:
                send(payload)
            while True:
                opcode, payload = receive()
                response = json.loads(payload)
                if response.get("id") == request["id"]:
                    return response

        label = os.environ["RELAY_LABEL"]
        # Like the real remote TUI, omit cwd unless the invocation specifies it.
        cwd_params = {"cwd": args[args.index("--cd") + 1]} if "--cd" in args else {}
        rpc({"id": 1, "method": "thread/start", "params": {"fixtureId": "shared-" + label, **cwd_params}}, fragmented=True)
        rpc({"id": 2, "method": "turn/start", "params": {"threadId": "shared-" + label, "input": [{"type": "text", "text": "Prompt " + label}]}})
        rpc({"id": 3, "method": "thread/resume", "params": {"fixtureId": "shared-" + label, **cwd_params}})
        rpc({"id": 4, "method": "thread/fork", "params": {"fixtureId": "fork-" + label, **cwd_params}})
        if os.environ.get("RELAY_HOLD") == "1":
            print("SHARED_RELAY_READY", flush=True)
            time.sleep(60)
        send(b"", opcode=8)
        assert receive()[0] == 8
    assert not os.path.exists(path) or os.stat(path).st_mode & 0o777 == 0o600
    print("SHARED_RELAY_OK", flush=True)
