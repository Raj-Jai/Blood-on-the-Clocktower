#!/usr/bin/env bash
# Rebuild shared + server and (re)start the API on :3001, detached, then wait for it.
#
# Kept as a file because the shell tool tears down its own process group on exit, so
# `nohup ... &` inline does not survive.
#
# The kill is done by PID, resolved from whoever is holding the port, and the script
# WAITS for :3001 to actually be free before starting again. That matters: a plain
# `pkill -f` left the old process alive, the new one died on EADDRINUSE, and the health
# check below happily reported "server up" against the OLD build — so a whole test cycle
# ran against stale code and looked like the fix simply had not worked.
set -euo pipefail
ROOT=/home/jai-raj/Data/Code/Assited/Blood-on-the-Clocktower
cd "$ROOT"

# The build is NOT silenced. It failed once on a missing type, the health check below
# still found the old process answering, and a whole test cycle ran against stale code
# that looked exactly like the fix not working. A restart script that cannot fail is
# worse than no restart script.
npm run build --workspace=packages/shared
npm run build --workspace=packages/server
echo "built shared + server"

# Whoever holds the port, whatever it was started as. Resolved with plain tools: `ss`
# and `pgrep`, no wrappers, because this has to work under `setsid` too.
PIDS="$(pgrep -f 'packages/server/dist/index.js' 2>/dev/null || true)"
for pid in $PIDS; do
  kill -9 "$pid" 2>/dev/null || true
done

# Wait for the port to be released, so the new process can actually bind.
for _ in $(seq 1 40); do
  ss -ltn 2>/dev/null | grep -q ':3001 ' || break
  sleep 0.25
done
if ss -ltn 2>/dev/null | grep -q ':3001 '; then
  echo "FATAL: :3001 is still held after killing [$PIDS]" >&2
  exit 1
fi

setsid nohup node packages/server/dist/index.js >/tmp/otc-server.log 2>&1 </dev/null &
disown || true

for _ in $(seq 1 40); do
  if curl -s -o /dev/null -X POST http://localhost:3001/api/sessions 2>/dev/null; then
    echo "server up (fresh build, pid $(pgrep -f 'packages/server/dist/index.js' | head -1))"
    exit 0
  fi
  sleep 0.5
done
echo "server did NOT come up" >&2
tail -20 /tmp/otc-server.log >&2
exit 1
