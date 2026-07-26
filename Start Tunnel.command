#!/bin/bash
echo "Starting Mirage tunnel — enter your Mac password when asked."
echo "Leave this window open while using Mirage. Close it to stop."
echo ""
sudo /Users/daniel/Desktop/Projects/pinpoint/backend/venv/bin/pymobiledevice3 remote tunneld
