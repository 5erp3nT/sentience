#!/bin/bash
# install_dock_icon.sh - Creates a Linux desktop shortcut for Sentience AI
# so it can be organically searched for and pinned to the sidebar (dock).

# Get the absolute path to this Sentience directory
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" >/dev/null 2>&1 && pwd )"

# Define the location for user desktop entries
DESKTOP_DIR="$HOME/.local/share/applications"
DESKTOP_FILE="$DESKTOP_DIR/sentience.desktop"

# Ensure the applications directory exists
mkdir -p "$DESKTOP_DIR"

# Write out the .desktop configuration
cat <<EOF > "$DESKTOP_FILE"
[Desktop Entry]
Version=1.0
Name=Sentience AI
Comment=Local AI Desktop Assistant
Exec=bash -c 'cd "$DIR" && ./start.sh'
Icon=$DIR/sentience_brain.png
Terminal=true
Type=Application
Categories=Utility;
EOF

chmod +x "$DESKTOP_FILE"
echo "✅ Successfully created Sentience AI desktop shortcut!"
echo "📍 Location: $DESKTOP_FILE"
echo ""
echo "You can now open your system Application menu (Super key), search for 'Sentience AI', right-click it, and select 'Add to Favorites' or drag it to your dock!"
