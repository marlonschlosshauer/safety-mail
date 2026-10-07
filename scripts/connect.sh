#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
npm run build
read -r -p 'Full T-Online email address: ' mail_user
read -r -s -p 'Separate password for email programs: ' mail_password
printf '\n'
trap 'unset mail_password mail_user' EXIT
# The renderer receives neither value through IPC. Main clears them before creating its window.
MAIL_MODE=live MAIL_USERNAME="$mail_user" MAIL_PASSWORD="$mail_password" \
  MAIL_REMEMBER="${MAIL_REMEMBER:-0}" ./node_modules/.bin/electron .
