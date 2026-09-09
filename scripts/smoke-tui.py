"""Opt-in smoke test against the installed Pi CLI. No model or user config access."""
import os
import pty
import re
import select
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

root = tempfile.mkdtemp(prefix="pi-team-tui-")
master, slave = pty.openpty()
source = Path(__file__).resolve().parent.parent / "src" / "index.ts"
env = dict(os.environ, PI_CODING_AGENT_DIR=root, PI_OFFLINE="1")
process = subprocess.Popen(
    ["pi", "--offline", "--no-session", "--no-extensions", "--no-skills",
     "--no-themes", "--no-context-files", "-e", str(source)],
    stdin=slave, stdout=slave, stderr=slave, env=env,
)
os.close(slave)
output = bytearray()


def collect(seconds):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if select.select([master], [], [], 0.1)[0]:
            try:
                output.extend(os.read(master, 65536))
            except OSError:
                break


try:
    collect(3)
    for command in ["/team create smoke", "/team join smoke pm", "/team members", "/team pause", "/team leave"]:
        os.write(master, command.encode() + b"\r")
        collect(1)
    os.write(master, b"\x03\x03")
    collect(1)
finally:
    process.terminate()
    try:
        process.wait(timeout=3)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
    os.close(master)
    shutil.rmtree(root)

text = re.sub(r"\x1b\[[0-?]*[ -/]*[@-~]", "", output.decode(errors="replace"))
for failure in ["Failed to load extension", "SyntaxError", "TypeError", "ReferenceError", "Extension error"]:
    assert failure.lower() not in text.lower(), text
assert "Joined smoke as pm" in text, text
assert "Team reception paused" in text, text
print("Real Pi TUI smoke passed: create/join/members/pause/leave; no model calls.")
