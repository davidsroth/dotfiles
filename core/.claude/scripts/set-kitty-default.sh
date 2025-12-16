#!/bin/bash

# Script to help set Kitty as the default terminal for various file types

echo "Setting Kitty as default for terminal-related file types..."

# Set Kitty as default for .command files
duti -s net.kovidgoyal.kitty .command all

# Set Kitty as default for .sh files (optional - you might want to keep these in your editor)
# duti -s net.kovidgoyal.kitty .sh all

echo "Done! Kitty is now set as default for .command files."
echo ""
echo "To manually set Kitty as default for other file types:"
echo "1. Right-click on a file of that type"
echo "2. Select 'Get Info'"
echo "3. Under 'Open with:', select Kitty"
echo "4. Click 'Change All...' to apply to all files of that type"
echo ""
echo "Note: You may need to install 'duti' via Homebrew if not already installed:"
echo "  brew install duti"