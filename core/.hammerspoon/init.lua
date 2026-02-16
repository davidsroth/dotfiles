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

-- Reload on changes in dotfiles repo and in the active Hammerspoon config dir
hs.pathwatcher.new(os.getenv("HOME") .. "/dotfiles/core/.hammerspoon/", hs.reload):start()
hs.pathwatcher.new(hs.configdir, hs.reload):start()
hs.application.enableSpotlightForNameSearches(true)

local launchKeys = {
	i = "WezTerm",
	m = "Messages",
	s = "Spotify",
	c = "Sunsama",
	f = "Finder",
	u = "Zen",
	v = "Antigravity",
	t = "Microsoft Teams",
}

local alts = {
	m = "Slack",
}

-- Load local overrides from init.local.lua if it exists
local localConfigPath = hs.configdir .. "/init.local.lua"
if hs.fs.attributes(localConfigPath) then
    local localConfig = loadfile(localConfigPath)()
    if localConfig then
        if localConfig.launchKeys then
            for k, v in pairs(localConfig.launchKeys) do launchKeys[k] = v end
        end
        if localConfig.alts then
            for k, v in pairs(localConfig.alts) do alts[k] = v end
        end
    end
end

for key, app in pairs(launchKeys) do
    hs.hotkey.bind({ "alt" }, key, function()
        launchOrFocusOrRotate(app)
    end)
end

for key, app in pairs(alts) do
    hs.hotkey.bind({ "alt", "ctrl" }, key, function()
        launchOrFocusOrRotate(app)
    end)
end

-- Swallow macOS dead-key leaders for Option+i/u so they don't compose
-- Hotkeys defined above (hs.hotkey.bind) will still fire; this just blocks text insertion
local swallowKeys = { i = true, u = true }
local swallowTap = hs.eventtap.new({ hs.eventtap.event.types.keyDown, hs.eventtap.event.types.keyUp }, function(event)
    local flags = event:getFlags()
    if flags.alt and not flags.cmd and not flags.ctrl then
        local kc = event:getKeyCode()
        for k, _ in pairs(swallowKeys) do
            if kc == hs.keycodes.map[k] then
                return true -- prevent dead-key / glyph from reaching apps
            end
        end
    end
    return false
end)
swallowTap:start()

-- Bind F-keys produced by Karabiner for Option+i/u
-- This avoids macOS dead-key composition while keeping Option-based muscle memory
hs.hotkey.bind({}, "f18", function() launchOrFocusOrRotate(launchKeys.i) end)
hs.hotkey.bind({}, "f19", function() launchOrFocusOrRotate(launchKeys.u) end)
