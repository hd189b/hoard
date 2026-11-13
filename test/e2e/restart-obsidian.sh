#!/bin/sh
# Restart the throwaway test Obsidian: restart-obsidian.sh <work-dir>
S="$1"
pkill -9 -f "[e]lectron --user-data-dir=$S/profile"
while pgrep -f "[e]lectron --user-data-dir=$S/profile" >/dev/null; do sleep 0.3; done
rm -f "$S/profile/SingletonLock" "$S/profile/SingletonSocket" "$S/profile/SingletonCookie"
(XDG_CONFIG_HOME="$S/xdg" setsid electron43 /usr/lib/obsidian/app.asar --user-data-dir="$S/profile" --remote-debugging-port=47300 > "$S/obsidian.log" 2>&1 &)
for i in $(seq 1 40); do curl -s http://127.0.0.1:47300/json | grep -q index.html && break; sleep 0.5; done
sleep 3
