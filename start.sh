#!/bin/bash
# Start the Voxtral Linux Statusbar AI Assistant

# Ensure the script runs from its own directory regardless of where it's called
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR"

# Activate the virtual environment
if [ -d ".venv" ]; then
    echo "Activating virtual environment..."
    source .venv/bin/activate
else
    echo "Error: Virtual environment not found at $DIR/.venv!"
    echo "Please ensure the .venv folder exists."
    exit 1
fi

echo "Starting Sentience Assistant..."
# Run the Native Linux Desktop Wrapper
# This automatically starts the backend server, cleans up old instances, 
# and provides the system tray icon to launch the Chrome App UI.
python3 desktop_app.py
