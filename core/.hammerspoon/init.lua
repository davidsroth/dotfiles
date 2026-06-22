-- launch, focus or rotate application
local function launchOrFocusOrRotate(app)
	local focusedWindow = hs.window.focusedWindow()
	-- If already focused, try to find the next window
	local appObj = focusedWindow and focusedWindow:application()
	if appObj and appObj:name() == app then
		local targetApp = hs.application.get(app)
		if not targetApp then
			hs.application.launchOrFocus(app)
			return
		end
		local appWindows = targetApp:allWindows()
		if #appWindows > 1 then
			-- It seems that this list order changes after one window get focused,
			-- let's directly bring the last one to focus every time
			appWindows[#appWindows]:focus()
		else -- this should not happen, but just in case
			targetApp:hide()
		end
	else -- if not focused
		hs.application.launchOrFocus(app)
	end
end

-- Reload on changes to the active Hammerspoon config dir.
-- `hs.configdir` is the symlink target of `~/.hammerspoon`, so it covers
-- edits made directly in the dotfiles repo without watching the same
-- directory twice.
local configWatcher = hs.pathwatcher.new(hs.configdir, hs.reload):start()
hs.application.enableSpotlightForNameSearches(true)

local launchKeys = {
	i = "WezTerm",
	m = "Messages",
	c = "Sunsama",
	f = "Finder",
	u = "Zen",
	v = "Antigravity",
}

local alts = {
	m = "Slack",
	s = "Spotify",
	t = "Microsoft Teams",
}

-- Load local overrides from init.local.lua if it exists
local localConfigPath = hs.configdir .. "/init.local.lua"
if hs.fs.attributes(localConfigPath) then
    local fn, err = loadfile(localConfigPath)
    if fn then
        local localConfig = fn()
        if localConfig then
            if localConfig.launchKeys then
                for k, v in pairs(localConfig.launchKeys) do launchKeys[k] = v end
            end
            if localConfig.alts then
                for k, v in pairs(localConfig.alts) do alts[k] = v end
            end
        end
    elseif err then
        hs.notify.show("Hammerspoon", "Config error", "init.local.lua: " .. tostring(err))
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

-- Note: ⌥i / ⌥u are bound directly via the launchKeys loop above. They no
-- longer need a Karabiner dead-key bypass because the "US-NoOption" keyboard
-- layout (installed by macos-defaults.sh) strips Option's glyph/dead-key plane.
