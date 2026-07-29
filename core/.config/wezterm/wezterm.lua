-- ============================================================================
-- WezTerm Configuration - Modern Setup (2024/2025)
-- ============================================================================
-- This configuration follows current best practices for performance,
-- usability, and modern terminal workflows.
-- ============================================================================

local wezterm = require("wezterm")

-- Initialize configuration with builder for better error messages
local config = wezterm.config_builder and wezterm.config_builder() or {}

-- ============================================================================
-- Appearance & Theme Configuration
-- ============================================================================

-- Keep dark mode only
config.color_scheme = "Catppuccin Mocha"

-- ============================================================================
-- Font Configuration
-- ============================================================================

-- Primary font: FiraCode Nerd Font Mono (matches Kitty, ships via Brewfile cask).
-- Fallbacks cover system fonts if the Nerd variant isn't installed.
config.font = wezterm.font_with_fallback({
	"FiraCode Nerd Font Mono",
	"Fira Code Retina",
	"Monaco",
	"Menlo",
})
config.font_size = tonumber(os.getenv("WEZTERM_FONT_SIZE")) or 12.0

-- Font rendering optimizations

-- Disable missing glyph warnings (you had this)
config.warn_about_missing_glyphs = false

-- ============================================================================
-- Performance Optimization
-- ============================================================================

-- Use WebGPU for better performance
config.front_end = "WebGpu"
config.max_fps = 120

-- ============================================================================
-- Window & Tab Configuration
-- ============================================================================

-- Tab bar settings
config.hide_tab_bar_if_only_one_tab = true
config.show_new_tab_button_in_tab_bar = false
config.tab_bar_at_bottom = false

-- Window settings
config.window_decorations = "RESIZE"
config.window_background_opacity = 1.0

-- macOS-specific optimizations
config.macos_forward_to_ime_modifier_mask = "SHIFT|CTRL"

-- ============================================================================
-- Terminal Behavior
-- ============================================================================

-- Emit CSI u key encoding so modifier+key combos that the legacy xterm
-- encoding can't represent (Ctrl+Enter, Shift+Enter, Ctrl+i vs Tab,
-- Ctrl+,, etc.) are sent unambiguously. Pairs with tmux's
-- `set -g extended-keys on` so Neovim and friends can map them.
config.enable_csi_u_key_encoding = true

-- Scrollback configuration
config.scrollback_lines = 10000
config.enable_scroll_bar = false

-- Quick-select (Leader+Space): extra targets beyond the built-in defaults
-- (URLs etc. stay active — these are additive).
config.quick_select_patterns = {
	[[\b[0-9a-f]{7,40}\b]], -- git SHAs
	[[[A-Za-z0-9._~-]*(?:/[A-Za-z0-9._-]+)+(?::[0-9]+)?]], -- file paths, optional :line
}

-- Mouse behavior
config.mouse_bindings = {
	-- Right click pastes from clipboard
	{
		event = { Down = { streak = 1, button = "Right" } },
		mods = "NONE",
		action = wezterm.action.PasteFrom("Clipboard"),
	},
}

-- ============================================================================
-- Key Bindings
-- ============================================================================

-- Leader key configuration for advanced operations
config.leader = { key = "a", mods = "CTRL", timeout_milliseconds = 1000 }

-- Cmd bracket chords drive Herdr, which needs a different encoding than
-- everything else: Herdr's parser treats Alt+[ / Alt+] (ESC [ and ESC ]) as
-- CSI/OSC introducers and swallows them, and only accepts CSI u with the super
-- modifier. 91 and 93 are '[' and ']'; modifier 9 = super(8) + 1, and 10 adds
-- shift(1). Outside Herdr the original action still applies.
local function herdr_or(csi_u, fallback)
	return wezterm.action_callback(function(window, pane)
		local proc = pane:get_foreground_process_name() or ""
		if proc:match("herdr$") then
			window:perform_action(wezterm.action.SendString(csi_u), pane)
		else
			window:perform_action(fallback, pane)
		end
	end)
end

-- Cmd+[ / Cmd+]: tmux windows (M-[ / M-]) or Herdr tabs.
local switch_prev_tab = herdr_or("\x1b[91;9u", wezterm.action.SendKey({ key = "[", mods = "ALT" }))
local switch_next_tab = herdr_or("\x1b[93;9u", wezterm.action.SendKey({ key = "]", mods = "ALT" }))

-- Cmd+Shift+[ / Cmd+Shift+]: Herdr workspaces, or WezTerm's own tabs elsewhere.
local switch_prev_workspace = herdr_or("\x1b[91;10u", wezterm.action.ActivateTabRelative(-1))
local switch_next_workspace = herdr_or("\x1b[93;10u", wezterm.action.ActivateTabRelative(1))

config.keys = {
	-- ============================================================================
	-- Pane Management
	-- ============================================================================

	-- Split panes
	{
		mods = "LEADER",
		key = "-",
		action = wezterm.action.SplitVertical({ domain = "CurrentPaneDomain" }),
	},
	{
		mods = "LEADER",
		key = "=",
		action = wezterm.action.SplitHorizontal({ domain = "CurrentPaneDomain" }),
	},

	-- Navigate panes
	{
		mods = "LEADER",
		key = "h",
		action = wezterm.action.ActivatePaneDirection("Left"),
	},
	{
		mods = "LEADER",
		key = "j",
		action = wezterm.action.ActivatePaneDirection("Down"),
	},
	{
		mods = "LEADER",
		key = "k",
		action = wezterm.action.ActivatePaneDirection("Up"),
	},
	{
		mods = "LEADER",
		key = "l",
		action = wezterm.action.ActivatePaneDirection("Right"),
	},

	-- Close pane
	{
		mods = "LEADER",
		key = "x",
		action = wezterm.action.CloseCurrentPane({ confirm = true }),
	},

	-- ============================================================================
	-- Tab Management
	-- ============================================================================

	-- Create new tab
	{
		mods = "LEADER",
		key = "c",
		action = wezterm.action.SpawnTab("CurrentPaneDomain"),
	},

	-- Navigate tabs
	{
		mods = "LEADER",
		key = "n",
		action = wezterm.action.ActivateTabRelative(1),
	},
	{
		mods = "LEADER",
		key = "p",
		action = wezterm.action.ActivateTabRelative(-1),
	},

	-- ============================================================================
	-- Copy Mode & Search
	-- ============================================================================

	-- Enter copy mode
	{
		key = "Enter",
		mods = "LEADER",
		action = wezterm.action.ActivateCopyMode,
	},

	-- Search
	{
		key = "f",
		mods = "LEADER",
		action = wezterm.action.Search({ CaseSensitiveString = "" }),
	},

	-- ============================================================================
	-- Modern Features
	-- ============================================================================

	-- Command palette
	{
		key = "P",
		mods = "CMD|SHIFT",
		action = wezterm.action.ActivateCommandPalette,
	},

	-- Copy selected text to the macOS clipboard.
	{
		key = "c",
		mods = "CMD",
		action = wezterm.action.CopyTo("Clipboard"),
	},

	-- Quick select mode
	{
		key = " ",
		mods = "LEADER",
		action = wezterm.action.QuickSelect,
	},

	-- ============================================================================
	-- Word Navigation (Option+Arrow)
	-- ============================================================================

	-- Option+Left: Move backward one word
	{
		key = "LeftArrow",
		mods = "OPT",
		action = wezterm.action.SendKey({ key = "b", mods = "ALT" }),
	},

	-- Option+Right: Move forward one word
	{
		key = "RightArrow",
		mods = "OPT",
		action = wezterm.action.SendKey({ key = "f", mods = "ALT" }),
	},

	-- Option+Backspace: Delete word backward
	{
		key = "Backspace",
		mods = "OPT",
		action = wezterm.action.SendKey({ key = "w", mods = "CTRL" }),
	},

	-- ============================================================================
	-- Tmux Integration
	-- ============================================================================

	-- Send Ctrl+G when Cmd+J is pressed (for tmux prefix)
	{
		key = "j",
		mods = "CMD",
		action = wezterm.action.SendKey({ key = "g", mods = "CTRL" }),
	},

	-- Switch tmux windows / Herdr tabs with Cmd+[ / Cmd+].
	-- tmux binds M-[ and M-] (keybindings.conf), but Herdr cannot: Alt+[ and
	-- Alt+] encode to ESC [ and ESC ], the CSI and OSC introducers, which
	-- Herdr's input parser swallows. Herdr does accept the CSI u super
	-- encoding, so pick the encoding from the pane's foreground process.
	{ key = "[", mods = "CMD", action = switch_prev_tab },
	{ key = "]", mods = "CMD", action = switch_next_tab },
	{ key = "[", mods = "CMD|SHIFT", action = switch_prev_workspace },
	{ key = "]", mods = "CMD|SHIFT", action = switch_next_workspace },

	-- Force CSI u encoding for Ctrl+Shift+S so tmux can bind it distinctly
	-- from plain Ctrl+S (which legacy xterm encoding collapses together).
	-- 115 = ASCII 's', modifier 6 = Shift(1) + Ctrl(4) + 1 per CSI u spec.
	-- tmux binding lives in core/.config/tmux/keybindings.conf (C-S-s).
	{
		key = "s",
		mods = "CTRL|SHIFT",
		action = wezterm.action.SendString("\x1b[115;6u"),
	},
}

-- ============================================================================
-- Visual Enhancements
-- ============================================================================

-- Cursor configuration
config.default_cursor_style = "SteadyBlock"

-- Bell configuration
config.audible_bell = "Disabled"
config.visual_bell = {
	fade_in_duration_ms = 75,
	fade_out_duration_ms = 75,
	target = "CursorColor",
}

-- ============================================================================
-- Update & Maintenance
-- ============================================================================

-- Disable update checks for privacy
config.check_for_updates = false

-- ============================================================================
-- Return Configuration
-- ============================================================================

return config
