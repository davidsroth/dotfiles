# Starship

A minimal, fast, and infinitely customizable prompt for any shell.

- **Docs**: <https://starship.rs/config/>
- **Repo**: <https://github.com/starship/starship>

## Local customizations

`starship.toml` (at the root of this `.config/` directory, not in a `starship/` subdir) uses a Catppuccin Mocha palette, renders `username@hostname in directory (BRANCH) status` on the first line, and places a single-character prompt indicator (`❯`) on the second line. Git status symbols are customized (`⇡` ahead, `⇣` behind, `?` untracked, etc.), and the hostname module is hidden outside SSH.
