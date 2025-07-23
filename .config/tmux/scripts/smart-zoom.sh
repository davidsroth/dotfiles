#!/usr/bin/env bash

# Get the number of panes in the current window
pane_count=$(tmux list-panes | wc -l | tr -d ' ')

# Check if we're already zoomed
zoomed=$(tmux display-message -p '#{window_zoomed_flag}')

if [ "$zoomed" = "1" ]; then
    # If already zoomed, just unzoom
    tmux resize-pane -Z
elif [ "$pane_count" = "1" ]; then
    # No split exists, create lower third split
    tmux split-window -v -c "#{pane_current_path}"
    tmux select-pane -U
    tmux resize-pane -y 70%
    tmux select-pane -D
else
    # Multiple panes exist, just zoom the current pane
    tmux resize-pane -Z
fi