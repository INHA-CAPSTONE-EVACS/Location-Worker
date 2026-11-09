#!/bin/sh
set -eu

Xvfb :1 -screen 0 1280x800x24 -ac +extension GLX +render -noreset &
x11vnc -display :1 -forever -shared -nopw -rfbport 5900 &
websockify --web /usr/share/novnc 6080 localhost:5900 &

if [ -n "${TRACI_PORT:-}" ]; then
  exec sumo-gui -c "${SUMO_CONFIG:-/app/scenario/mini.sumocfg}" \
    --remote-port "$TRACI_PORT" --start --delay "${SUMO_DELAY_MS:-100}"
fi

exec sumo-gui -c "${SUMO_CONFIG:-/app/scenario/mini.sumocfg}" --delay "${SUMO_DELAY_MS:-100}"
