#!/bin/bash
echo "Starting PinPoint tunnel — enter your Mac password when asked."
echo "Leave this window open while using PinPoint. Close it to stop."
echo ""
sudo /Users/daniel/Desktop/Projects/pinpoint/backend/venv/bin/pymobiledevice3 remote tunneld
