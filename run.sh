#!/bin/sh
# Serves Chit on port 5178 to this Mac and to phones on the same Wi-Fi.
cd "$(dirname "$0")"
PORT=5178
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)

echo ""
echo "  Chit is running."
echo "  On this Mac:   http://localhost:$PORT"
if [ -n "$IP" ]; then
  echo "  On your phone: http://$IP:$PORT   (same Wi-Fi, scan below)"
  echo ""
  npx --yes qrcode@1.5.4 -t terminal -s 1 "http://$IP:$PORT" 2>/dev/null
fi
echo ""
echo "  Ctrl+C to stop."
echo ""
exec python3 -m http.server "$PORT" --bind 0.0.0.0 >/dev/null 2>&1
