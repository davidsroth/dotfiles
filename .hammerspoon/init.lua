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

hs.application.enableSpotlightForNameSearches(true)
hs.pathwatcher.new(os.getenv("HOME") .. "/.hammerspoon/", hs.reload):start()

hs.hotkey.bind({ "alt" }, "t", function()
	toggle_application("iTerm")
end)

hs.hotkey.bind({ "alt" }, "o", function()
	toggle_application("Obsidian")
end)

hs.hotkey.bind({ "alt" }, "a", function()
	toggle_application("Arc")
end)

hs.hotkey.bind({ "alt" }, "m", function()
	toggle_application("Messages")
end)

hs.hotkey.bind({ "alt" }, "s", function()
	toggle_application("Spotify")
end)
