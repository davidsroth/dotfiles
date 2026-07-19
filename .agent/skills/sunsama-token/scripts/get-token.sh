#!/usr/bin/env bash
# Extract Sunsama JWT token from Zen browser cookies

set -euo pipefail

COOKIES_DB="$HOME/Library/Application Support/zen/Profiles/v8q5nzq9.Default (release)/cookies.sqlite"
TMP_DB="/tmp/zen_cookies_$$.sqlite"

cleanup() {
    rm -f "$TMP_DB"
}
trap cleanup EXIT

if [[ ! -f "$COOKIES_DB" ]]; then
    echo "Error: Zen cookies database not found at: $COOKIES_DB" >&2
    exit 1
fi

cp "$COOKIES_DB" "$TMP_DB"

token=$(sqlite3 "$TMP_DB" "SELECT value FROM moz_cookies WHERE name='sunsamaSession' AND host LIKE '%sunsama%';" 2>/dev/null)

if [[ -z "$token" ]]; then
    echo "Error: No sunsamaSession cookie found" >&2
    exit 1
fi

echo "$token"
