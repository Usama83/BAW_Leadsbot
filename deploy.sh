#!/usr/bin/env bash
# One-command VPS deployment for BAW Leadsbot.
# On a fresh Ubuntu/Debian VPS, run as root:
#   bash <(curl -fsSL https://raw.githubusercontent.com/Usama83/BAW_Leadsbot/claude/rasayel-ad-attribution-bot-fersyw/deploy.sh)
set -e

REPO=https://github.com/Usama83/BAW_Leadsbot.git
BRANCH=claude/rasayel-ad-attribution-bot-fersyw
DIR=/opt/leadsbot

echo "== BAW Leadsbot deploy =="

if ! command -v node >/dev/null 2>&1; then
  echo "-- installing Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
command -v git >/dev/null 2>&1 || apt-get install -y git

if [ -d "$DIR/.git" ]; then
  echo "-- updating existing install"
  git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout "$BRANCH" && git -C "$DIR" pull
else
  echo "-- cloning"
  git clone -b "$BRANCH" "$REPO" "$DIR"
fi

cd "$DIR"
npm install --omit=dev
mkdir -p log

if [ ! -f .env ]; then
  cp .env.example .env
  NEED_ENV=1
fi

command -v pm2 >/dev/null 2>&1 || npm install -g pm2
pm2 describe leadsbot >/dev/null 2>&1 && pm2 restart leadsbot || pm2 start server.js --name leadsbot
pm2 save
pm2 startup systemd -u "$(whoami)" --hp "$HOME" 2>/dev/null | tail -1 | bash || true

# nightly syncs (idempotent — tagged lines are replaced on re-run)
( crontab -l 2>/dev/null | grep -v '# leadsbot-sync' ; cat <<CRON
0 3 * * * cd $DIR && node scripts/sync-ad-conversations.js >> log/sync.log 2>&1 # leadsbot-sync
15 3 * * * cd $DIR && node scripts/resolve-fbme.js >> log/sync.log 2>&1 # leadsbot-sync
30 3 * * * cd $DIR && node scripts/fetch-ad-insights.js >> log/sync.log 2>&1 # leadsbot-sync
45 3 * * * cd $DIR && node scripts/sync-odoo.js >> log/sync.log 2>&1 # leadsbot-sync
CRON
) | crontab -

IP=$(curl -fsS ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')
echo ""
echo "== Deployed =="
echo "Dashboard:  http://$IP:3000/dashboard"
echo "APIs:       http://$IP:3000/ad-sos  /payloads  /ad-names"
if [ -n "$NEED_ENV" ]; then
  echo ""
  echo ">>> REQUIRED NEXT STEP: fill the credentials, then restart:"
  echo "      nano $DIR/.env"
  echo "      pm2 restart leadsbot"
fi
echo ""
echo "Then in Rasayel (Settings > Integrations > Webhooks) register:"
echo "      http://$IP:3000/webhooks/rasayel"
echo "For HTTPS + a domain, install nginx + certbot (see HANDOFF.md section 6)."
