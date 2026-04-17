-- No-op previewer: suppresses image preview in tmux where terminal
-- probe responses (DECRQSS/CSI 16t) get misinterpreted as keystrokes.
return { peek = function() end }
