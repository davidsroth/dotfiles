#!/usr/bin/env bash

# macOS System Preferences
# ========================
# Apply opinionated macOS defaults for development
# Run: ./macos-defaults.sh
# Note: Some changes require logout/restart to take effect

set -euo pipefail

# Script metadata

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[0;33m'
readonly BLUE='\033[0;34m'
readonly NC='\033[0m' # No Color

# Helper functions
info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

success() {
    echo -e "${GREEN}[✓]${NC} $1"
}

warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

error() {
    echo -e "${RED}[ERROR]${NC} $1" >&2
}

# Close System Preferences to prevent conflicts
osascript -e 'tell application "System Preferences" to quit' 2>/dev/null || true

# =============================================================================
# Accessibility
# =============================================================================

info "Configuring Accessibility settings..."

# Enable reduce motion (reduces animations system-wide)
defaults write com.apple.Accessibility ReduceMotionEnabled -bool true
success "Enabled reduce motion"

# Reduce transparency for better performance and readability
defaults write com.apple.Accessibility ReduceTransparencyEnabled -bool true
success "Reduced transparency"

# =============================================================================
# Trackpad & Mouse
# =============================================================================

info "Configuring Trackpad settings..."

# Enable three finger drag
defaults write com.apple.driver.AppleBluetoothMultitouch.trackpad TrackpadThreeFingerDrag -bool true
defaults write com.apple.AppleMultitouchTrackpad TrackpadThreeFingerDrag -bool true
success "Enabled three finger drag"

# =============================================================================
# Keyboard
# =============================================================================

info "Configuring Keyboard settings..."

# Set fast key repeat rate
defaults write NSGlobalDomain KeyRepeat -int 2
defaults write NSGlobalDomain InitialKeyRepeat -int 15
success "Set fast key repeat"

# Disable press-and-hold for keys in favor of key repeat
defaults write NSGlobalDomain ApplePressAndHoldEnabled -bool false
success "Disabled press-and-hold"

# =============================================================================
# Finder
# =============================================================================

info "Configuring Finder settings..."

# Show file extensions
defaults write NSGlobalDomain AppleShowAllExtensions -bool true
success "Show all file extensions"

# Show hidden files
defaults write com.apple.finder AppleShowAllFiles -bool true
success "Show hidden files"

# Show path bar
defaults write com.apple.finder ShowPathbar -bool true
success "Show path bar"

# Show status bar
defaults write com.apple.finder ShowStatusBar -bool true
success "Show status bar"

# Set default view style to list view
defaults write com.apple.finder FXPreferredViewStyle -string "Nlsv"
success "Set list view as default"

# Disable warning when changing file extensions
defaults write com.apple.finder FXEnableExtensionChangeWarning -bool false
success "Disabled extension change warning"

# =============================================================================
# Dock
# =============================================================================

info "Configuring Dock settings..."

# Set Dock size
defaults write com.apple.dock tilesize -int 52
success "Set Dock icon size"

# Disable Dock magnification
defaults write com.apple.dock magnification -bool false
success "Disabled Dock magnification"

# Minimize windows using scale effect (faster than genie)
defaults write com.apple.dock mineffect -string "scale"
success "Set minimize effect to scale"

# Auto-hide Dock
defaults write com.apple.dock autohide -bool true
defaults write com.apple.dock autohide-delay -float 0
defaults write com.apple.dock autohide-time-modifier -float 0.81
success "Enabled Dock auto-hide"

# Don't show recent applications in Dock
defaults write com.apple.dock show-recents -bool false
success "Disabled recent apps in Dock"

# =============================================================================
# Screenshots
# =============================================================================

info "Configuring Screenshot settings..."

# Create screenshots directory
mkdir -p ~/Pictures/Screenshots

# Save screenshots to Pictures/Screenshots
defaults write com.apple.screencapture location -string "${HOME}/Pictures/Screenshots"
success "Set screenshot location"

# Save screenshots in PNG format
defaults write com.apple.screencapture type -string "png"
success "Set screenshot format to PNG"

# Disable shadow in screenshots
defaults write com.apple.screencapture disable-shadow -bool true
success "Disabled screenshot shadows"

# =============================================================================
# Safari & WebKit
# =============================================================================

info "Configuring Safari settings..."

# Enable Developer menu
defaults write com.apple.Safari IncludeDevelopMenu -bool true 2>/dev/null || warning "Could not set Safari Developer menu (Safari may need to be opened first)"
defaults write com.apple.Safari WebKitDeveloperExtrasEnabledPreferenceKey -bool true 2>/dev/null || true
success "Safari Developer settings applied (if possible)"

# Show full URL
defaults write com.apple.Safari ShowFullURLInSmartSearchField -bool true 2>/dev/null || true
success "Safari URL settings applied (if possible)"

# =============================================================================
# Terminal
# =============================================================================

info "Configuring Terminal settings..."

# Only use UTF-8 in Terminal.app
defaults write com.apple.terminal StringEncodings -array 4
success "Set Terminal to UTF-8"

# Enable Secure Keyboard Entry in Terminal.app
defaults write com.apple.terminal SecureKeyboardEntry -bool true
success "Enabled secure keyboard entry"

# =============================================================================
# Energy Saving
# =============================================================================

info "Configuring Energy settings..."

# Disable automatic termination of inactive apps
defaults write NSGlobalDomain NSDisableAutomaticTermination -bool true
success "Disabled automatic app termination"

# =============================================================================
# Miscellaneous
# =============================================================================

info "Configuring miscellaneous settings..."

# Expand save panel by default
defaults write NSGlobalDomain NSNavPanelExpandedStateForSaveMode -bool true
defaults write NSGlobalDomain NSNavPanelExpandedStateForSaveMode2 -bool true
success "Expand save panel by default"

# Expand print panel by default
defaults write NSGlobalDomain PMPrintingExpandedStateForPrint -bool true
defaults write NSGlobalDomain PMPrintingExpandedStateForPrint2 -bool true
success "Expand print panel by default"

# Save to disk (not to iCloud) by default
defaults write NSGlobalDomain NSDocumentSaveNewDocumentsToCloud -bool false
success "Save to disk by default"

# Disable automatic capitalization
defaults write NSGlobalDomain NSAutomaticCapitalizationEnabled -bool false
success "Disabled automatic capitalization"

# Disable smart dashes
defaults write NSGlobalDomain NSAutomaticDashSubstitutionEnabled -bool false
success "Disabled smart dashes"

# Disable automatic period substitution
defaults write NSGlobalDomain NSAutomaticPeriodSubstitutionEnabled -bool false
success "Disabled automatic period substitution"

# Disable smart quotes
defaults write NSGlobalDomain NSAutomaticQuoteSubstitutionEnabled -bool false
success "Disabled smart quotes"

# Disable auto-correct
defaults write NSGlobalDomain NSAutomaticSpellingCorrectionEnabled -bool false
success "Disabled auto-correct"

# =============================================================================
# Kill affected applications
# =============================================================================

info "Restarting affected applications..."

for app in "Dock" "Finder" "SystemUIServer"; do
    killall "${app}" &> /dev/null || true
done

success "macOS defaults applied successfully!"
echo
warning "Some changes require logging out or restarting to take full effect."
echo
info "Notable changes:"
echo "  • Reduce motion is enabled (less animations)"
echo "  • Transparency is reduced"
echo "  • Three finger drag is enabled"
echo "  • File extensions are shown"
echo "  • Hidden files are visible"
echo "  • Dock auto-hides"
echo "  • Screenshots save to ~/Pictures/Screenshots"
echo "  • Fast key repeat is enabled"
echo "  • Auto-correct and smart substitutions are disabled"
