#!/usr/bin/env bash
#
# Install (or update) the KW Estate dashboard on srv1340120.
#
#   curl -fsSL <raw url>/deploy/install.sh | bash      # or just run it from a checkout
#   sudo bash deploy/install.sh
#
# Safe to run repeatedly. It is the update path as well as the install path.
#
# What it does:
#   /opt/kw-estate            the checkout; the timer rebuilds dist/ in place
#   kw-estate.service/.timer  four collection passes a day
#   nginx vhost               one new server_name, TLS + basic auth
#
# What it deliberately does NOT do:
#   - touch any other vhost, port, unit or container on this box
#   - reload nginx unless `nginx -t` passes
#   - enable the timer until SSH to all three servers is proven to work
#   - install Node; if it is missing it tells you and stops

set -euo pipefail

REPO="${REPO:-https://github.com/it6-ash/master.git}"
DIR="${DIR:-/opt/kw-estate}"
BRANCH="${BRANCH:-main}"
DOMAIN="${DOMAIN:-estate.leadq.co.in}"
KEY="${KEY:-/root/.ssh/id_ed25519}"

# tunnel — loopback only, behind the cloudflared this box already runs, gated by
#          Cloudflare Access. No public port, no certificate to renew.
# public — 443 with certbot and HTTP basic auth.
MODE="${MODE:-tunnel}"

# Paths git may own on this box are code only. data/ and dist/ are live state
# here and must never be merged over.
CODE_PATHS=(src schema content deploy test kw-collect.sh package.json playwright.config.js README.md)

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run this as root (sudo bash deploy/install.sh)"

# --------------------------------------------------------------- preflight

say "Checking what this box already has"

command -v git >/dev/null   || die "git is not installed:   apt install -y git"
command -v nginx >/dev/null || die "nginx is not installed. This is meant to run on the box that already terminates TLS."

command -v node >/dev/null || die "Node is not installed. Node 20+:
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash - && apt install -y nodejs"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 20 ] || die "Node $NODE_MAJOR is too old; this needs 20+."
ok "node $(node -v), nginx, git"

# Only MODE=public needs it. Don't install a package on a production box that
# the chosen path will never call. An `if`, not `[ ] && [ ] && ...`, because a
# false test at the end of a && chain exits the script under `set -e`.
if [ "$MODE" = "public" ] && ! command -v htpasswd >/dev/null; then
  warn "htpasswd missing, installing apache2-utils"
  apt-get install -y -qq apache2-utils
fi

# ------------------------------------------------------------- the checkout

if [ -d "$DIR/.git" ]; then
  say "Updating the checkout at $DIR"
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  # Take code from origin without merging: data/ and dist/ on this box are
  # newer than anything in the repo and a pull would conflict on every run.
  for p in "${CODE_PATHS[@]}"; do
    git -C "$DIR" checkout --quiet "origin/$BRANCH" -- "$p" 2>/dev/null || true
  done
  ok "code updated to origin/$BRANCH; data/ and dist/ left alone"
else
  say "Cloning into $DIR"
  git clone --quiet --branch "$BRANCH" "$REPO" "$DIR" \
    || die "clone failed. If the repo is private, add a deploy key first:
    ssh-keygen -t ed25519 -f /root/.ssh/id_ed25519 -N ''
    ... then add /root/.ssh/id_ed25519.pub as a deploy key on GitHub and re-run
    with REPO=git@github.com:it6-ash/master.git"
  ok "cloned"
fi

# nginx reads dist/ as www-data.
chmod 755 "$DIR" "$DIR/dist" 2>/dev/null || true

# ------------------------------------------------------------------ ssh key

say "SSH access to the three servers"

if [ ! -f "$KEY" ]; then
  ssh-keygen -t ed25519 -f "$KEY" -N '' -C "kw-estate@$(hostname)" >/dev/null
  ok "generated $KEY"
fi

# This box collects from itself too. Over loopback, not its public IP: no
# hairpin, no firewall rule, and it keeps one code path for all three.
grep -qF "$(cat "$KEY.pub")" /root/.ssh/authorized_keys 2>/dev/null || {
  mkdir -p /root/.ssh && chmod 700 /root/.ssh
  cat "$KEY.pub" >> /root/.ssh/authorized_keys
  chmod 600 /root/.ssh/authorized_keys
  ok "authorised this box to reach itself over loopback"
}

if [ ! -f "$DIR/config/hosts.json" ]; then
  mkdir -p "$DIR/config"
  cat > "$DIR/config/hosts.json" <<JSON
{
  "defaults": { "user": "root", "key": "$KEY" },
  "hosts": {
    "srv1340120": { "host": "127.0.0.1" },
    "srv1870078": { "host": "200.141.9.83" },
    "srv1900820": { "host": "200.234.35.172" }
  },
  "deploy": { "host": "srv1340120", "path": "$DIR/dist" }
}
JSON
  chmod 600 "$DIR/config/hosts.json"
  ok "wrote config/hosts.json (git-ignored)"
fi

printf '\n    This key must be in root@authorized_keys on the OTHER TWO boxes:\n\n'
printf '\033[2m%s\033[0m\n\n' "$(cat "$KEY.pub")"

REACHABLE=0
UNREACHABLE=()
for h in 127.0.0.1 200.141.9.83 200.234.35.172; do
  if ssh -i "$KEY" -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 \
       "root@$h" true 2>/dev/null; then
    ok "root@$h"
    REACHABLE=$((REACHABLE + 1))
  else
    warn "root@$h unreachable"
    UNREACHABLE+=("$h")
  fi
done

# --------------------------------------------------------------- the units

say "systemd"

install -m 644 "$DIR/deploy/kw-estate.service" /etc/systemd/system/kw-estate.service
install -m 644 "$DIR/deploy/kw-estate.timer"   /etc/systemd/system/kw-estate.timer
systemctl daemon-reload
ok "kw-estate.service + kw-estate.timer installed"

if [ "$REACHABLE" -eq 3 ]; then
  systemctl enable --now kw-estate.timer >/dev/null
  ok "timer enabled — four passes a day"
else
  warn "timer installed but NOT enabled: ${UNREACHABLE[*]} still unreachable."
  warn "add the key above to those boxes, then: systemctl enable --now kw-estate.timer"
fi

# ----------------------------------------------------------------- the vhost

say "nginx ($MODE)"

enable_vhost() {
  install -m 644 "$DIR/deploy/$1" /etc/nginx/sites-available/kw-estate
  ln -sfn /etc/nginx/sites-available/kw-estate /etc/nginx/sites-enabled/kw-estate
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    ok "vhost enabled and nginx reloaded"
  else
    rm -f /etc/nginx/sites-enabled/kw-estate
    nginx -t || true
    die "nginx -t failed; the vhost was removed again and nginx was NOT reloaded."
  fi
}

if [ -e /etc/nginx/sites-enabled/kw-estate ]; then
  ok "vhost already enabled"
elif [ "$MODE" = "tunnel" ]; then
  enable_vhost kw-estate.tunnel.nginx.conf
  ok "listening on 127.0.0.1:8060 only — no public port claimed"
  warn "the tunnel half is yours: add the ingress rule, route the DNS, then put"
  warn "$DOMAIN behind Cloudflare Access. Until Access exists, it is PUBLIC."
elif [ -f /etc/nginx/.kw-estate-htpasswd ]; then
  enable_vhost kw-estate.nginx.conf
else
  warn "no /etc/nginx/.kw-estate-htpasswd yet, and MODE=public needs one."
  warn "This page must not be public. Create it, then re-run:"
  warn "  htpasswd -c /etc/nginx/.kw-estate-htpasswd <user>"
fi

# ------------------------------------------------------------------ first run

say "First collection pass"
if [ "$REACHABLE" -gt 0 ]; then
  systemctl start kw-estate.service || warn "the pass failed; journalctl -u kw-estate -n 50"
  ok "$(ls -l "$DIR/dist/index.html" 2>/dev/null | awk '{print $5" bytes  "$6" "$7" "$8}')"
else
  warn "skipped: no server is reachable yet"
fi

cat <<EOF

Done.

  systemctl list-timers kw-estate.timer     when it next runs
  systemctl start kw-estate                 run a pass now
  journalctl -u kw-estate -n 50             what the last pass did
  bash $DIR/deploy/install.sh               update the code, keep the data
  curl -sI http://127.0.0.1:8060/ -H 'Host: $DOMAIN'   is nginx serving it

EOF

if [ "$MODE" = "tunnel" ]; then
cat <<EOF
Still yours to do, on this box and in Cloudflare:
  1. add to the cloudflared ingress, above the catch-all:
       - hostname: $DOMAIN
         service: http://127.0.0.1:8060
  2. cloudflared tunnel route dns <tunnel-name> $DOMAIN
  3. systemctl restart cloudflared
  4. Zero Trust -> Access -> Applications -> add $DOMAIN, allow your emails

Step 4 is the authentication. Skip it and this page is public, and it names
every open port, every failed unit and every unrotated credential in the estate.
EOF
else
cat <<EOF
Still yours to do:
  point $DOMAIN at $(hostname -I 2>/dev/null | awk '{print $1}') in DNS, unproxied
  certbot --nginx -d $DOMAIN

The basic auth is not decoration. This page names every open port, every failed
unit and every unrotated credential in the estate.
EOF
fi
