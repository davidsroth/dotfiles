function toggle_application(name)
	local app = hs.application.get(name)
	if not app then
		-- The application isn't running, start it
		hs.application.launchOrFocus(name)
	elseif app:isFrontmost() then
		-- The application is running and is foremost, hide it
		app:hide()
	else
		-- The application is running but not foremost, focus it
		hs.application.launchOrFocus(name)
	end
end

-- launch, focus or rotate application
local function launchOrFocusOrRotate(app)
	local focusedWindow = hs.window.focusedWindow()
	-- If already focused, try to find the next window
	if focusedWindow and focusedWindow:application():name() == app then
		local appWindows = hs.application.get(app):allWindows()
		if #appWindows > 1 then
			-- It seems that this list order changes after one window get focused,
			-- let's directly bring the last one to focus every time
			appWindows[#appWindows]:focus()
		else -- this should not happen, but just in case
			-- hs.application.launchOrFocus(app)
			hs.application.get(app):hide()
		end
	else -- if not focused
		hs.application.launchOrFocus(app)
	end
end

hs.pathwatcher.new(os.getenv("HOME") .. "~/dotfiles/.hammerspoon/", hs.reload):start()
hs.application.enableSpotlightForNameSearches(true)

local launchKeys = {
	{ "i", "iTerm" },
	{ "o", "Obsidian" },
	{ "m", "Messages" },
	{ "s", "Spotify" },
	{ "c", "Calendar" },
	{ "f", "Finder" },
	{ "b", "Bitwarden" },
	{ "u", "Arc" },
}

for _, app in ipairs(launchKeys) do
	hs.hotkey.bind({ "alt" }, app[1], function()
		launchOrFocusOrRotate(app[2])
	end)
end
