---
name: sunsama-token
description: This skill should be used when the user asks to "get sunsama token", "fetch sunsama jwt", "sunsama authentication", "sunsama api token", or needs the Sunsama session token for API calls or MCP integration.
version: 1.0.0
---

# Sunsama Token

Fetch the Sunsama JWT session token from Zen browser cookies.

## Overview

Sunsama stores its session token as a JWT in a cookie named `sunsamaSession`. This skill extracts the token from the Zen browser's cookies database.

## When to Use

- Authenticating with the Sunsama API
- Configuring Sunsama MCP integration
- Debugging Sunsama authentication issues
- Retrieving current session information

## Procedure

### Using the Script

Execute the helper script to retrieve the token:

```bash
~/.claude/skills/sunsama-token/scripts/get-token.sh
```

The script:
1. Copies the cookies database to /tmp (avoids browser lock issues)
2. Queries the `sunsamaSession` cookie for `sunsama.com`
3. Outputs the raw JWT token
4. Cleans up the temporary file

### Manual Extraction

To extract manually:

```bash
cp "$HOME/Library/Application Support/zen/Profiles/v8q5nzq9.Default (release)/cookies.sqlite" /tmp/zen_cookies.sqlite
sqlite3 /tmp/zen_cookies.sqlite "SELECT value FROM moz_cookies WHERE name='sunsamaSession' AND host LIKE '%sunsama%';"
rm /tmp/zen_cookies.sqlite
```

## Token Information

The JWT payload contains:
- `userId`: Sunsama user ID
- `groupId`: Workspace/group ID
- `sessionId`: Current session identifier
- `exp`: Expiration timestamp

## Scripts

- **`scripts/get-token.sh`** - Extracts and outputs the Sunsama JWT token
