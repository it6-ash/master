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

# public — nginx on 80/443 with certbot and HTTP basic auth. What this estate uses.
# tunnel — loopback only, behind the cloudflared this box already runs, gated by
#          Cloudflare Access. No public port and no certificate to renew, but it
#          needs an ingress rule and an Access policy to be worth anything.
MODE="${MODE:-public}"

# basic — htpasswd prompt.
# none  — no authentication at all. The page is then readable by anyone who
#         resolves the hostname. See the warning install.sh prints.
#
# Left EMPTY on purpose. Unset, it is read back from the deployed vhost further
# down, so re-running this script keeps whatever is currently configured. It
# used to default to basic, which meant every routine `bash install.sh` silently
# put the password prompt back on a site someone had deliberately opened.
#
# For "no prompt, still not public", leave it at basic and replace the two
# auth_basic lines in the vhost with:  allow <your.ip>;  deny all;
AUTH="${AUTH:-}"

# Which paths git may overwrite lives in deploy/pull.sh — one definition, used
# by this script and by the service's ExecStartPre on every collection pass.

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

# ------------------------------------------------------------- the checkout

SELF="$DIR/deploy/install.sh"
selfsum() { [ -f "$SELF" ] && sha256sum "$SELF" | cut -d' ' -f1 || echo none; }

if [ -d "$DIR/.git" ]; then
  say "Updating the checkout at $DIR"
  BEFORE="$(selfsum)"
  DIR="$DIR" BRANCH="$BRANCH" bash "$DIR/deploy/pull.sh" | sed 's/^/    /'

  # This script updates itself. Bash reads a script incrementally by byte
  # offset, so carrying on after the file changed underneath us runs a mix of
  # old and new — which is exactly how a fixed bug appears to survive its fix.
  # ponytail: re-exec here rather than wrapping the whole file in a main()
  # function; the checkout is early enough that bash has not read past it.
  if [ -z "${KW_ESTATE_REEXEC:-}" ] && [ "$BEFORE" != "$(selfsum)" ]; then
    ok "install.sh changed; running the new one"
    KW_ESTATE_REEXEC=1 exec bash "$SELF" "$@"
  fi
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

# This box collects from itself by running the collector directly. No key in
# its own authorized_keys, no root login from itself for sshd to allow or
# refuse — one less credential on the box and one less thing to misconfigure.
ok "this box collects itself locally; no ssh to 127.0.0.1 needed"

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
printf '    If ssh to one of them answers "Permission denied (publickey)", that box
    has password auth off and you cannot push the key over ssh at all. Use
    hPanel -> VPS -> Browser terminal, or hPanel -> VPS -> SSH keys, which
    writes it to root for you. Then re-run this script.\n\n'

REACHABLE=1          # this box, collected locally
UNREACHABLE=()
for h in 200.141.9.83 200.234.35.172; do
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

VHOST=/etc/nginx/sites-available/kw-estate

# Read the current setting off the deployed vhost rather than defaulting. The
# file IS the state — no second copy in /etc to drift out of sync with it.
if [ -z "$AUTH" ]; then
  if grep -qE '^[[:space:]]*#[[:space:]]*auth_basic' "$VHOST" 2>/dev/null; then
    AUTH=none
  else
    AUTH=basic
  fi
  ok "auth: $AUTH (unchanged — pass AUTH=none or AUTH=basic to switch)"
fi

if [ "$AUTH" = "basic" ] && [ "$MODE" = "public" ] && ! command -v htpasswd >/dev/null; then
  warn "htpasswd missing, installing apache2-utils"
  apt-get install -y -qq apache2-utils
fi

# Idempotent, and safe to re-run after certbot has been at the file.
enable_vhost() {
  local wanted="$DIR/deploy/$1"

  if grep -q "ssl_certificate" "$VHOST" 2>/dev/null; then
    # certbot --nginx rewrites this file IN PLACE: it adds the 443 server and
    # turns port 80 into a redirect. Overwriting it with the shipped template
    # deletes the only TLS server for this hostname, and https then falls
    # through to nginx's default site — the stock welcome page.
    ok "existing vhost carries certbot's TLS; editing it, not replacing it"
  elif grep -q "127.0.0.1:8060" "$VHOST" 2>/dev/null && [ "$MODE" = "public" ]; then
    warn "replacing the tunnel vhost with the public one"
    install -m 644 "$wanted" "$VHOST"
  elif [ ! -f "$VHOST" ] || ! grep -q "kw-estate" "$VHOST" 2>/dev/null; then
    install -m 644 "$wanted" "$VHOST"
  else
    ok "vhost already installed"
  fi

  # Auth is a two-line edit either way, so it applies to a certbot-rewritten
  # file exactly as well as to a fresh one. Comment rather than delete, so
  # turning it back on is the same edit in reverse.
  case "$AUTH" in
    none)
      sed -i 's/^\( *\)auth_basic/\1# auth_basic/' "$VHOST"
      warn "AUTH=none — this page is readable by anyone who resolves $DOMAIN."
      warn "It lists every IP, open port, failed unit and unrotated credential here."
      ;;
    basic)
      sed -i 's/^\( *\)# *auth_basic/\1auth_basic/' "$VHOST"
      [ -f /etc/nginx/.kw-estate-htpasswd ] \
        || warn "auth_basic is on but /etc/nginx/.kw-estate-htpasswd does not exist — nginx will 500"
      ;;
  esac

  ln -sfn "$VHOST" /etc/nginx/sites-enabled/kw-estate
  if nginx -t 2>/dev/null; then
    systemctl reload nginx
    ok "vhost enabled and nginx reloaded"
  else
    rm -f /etc/nginx/sites-enabled/kw-estate
    nginx -t || true
    die "nginx -t failed; the vhost was removed again and nginx was NOT reloaded."
  fi
}

if [ "$MODE" = "tunnel" ]; then
  enable_vhost kw-estate.tunnel.nginx.conf
  ok "listening on 127.0.0.1:8060 only — no public port claimed"
  warn "the tunnel half is yours: add the ingress rule, route the DNS, then put"
  warn "$DOMAIN behind Cloudflare Access. Until Access exists, it is PUBLIC."
elif [ "$AUTH" = "none" ] || [ -f /etc/nginx/.kw-estate-htpasswd ]; then
  enable_vhost kw-estate.nginx.conf
else
  warn "no /etc/nginx/.kw-estate-htpasswd yet, and AUTH=basic needs one."
  warn "Create it and re-run, or pass AUTH=none if you meant to publish this:"
  warn "  htpasswd -c /etc/nginx/.kw-estate-htpasswd <user>"
fi

# ---------------------------------------------------------------- the tunnel

if [ "$MODE" = "tunnel" ]; then
  say "cloudflared"

  # Ask systemd which config the RUNNING tunnel reads. cloudflared invoked by
  # hand with no --config defaults to ~/.cloudflared/config.yml, so "validate"
  # cheerfully reports OK on a file the service never opens.
  CF_CONF="$(systemctl cat cloudflared 2>/dev/null | sed -n 's/.*--config[= ]\([^ ]*\).*/\1/p' | head -1)"
  [ -n "$CF_CONF" ] || CF_CONF=/etc/cloudflared/config.yml

  if [ ! -f "$CF_CONF" ]; then
    warn "no cloudflared config at $CF_CONF — is this tunnel managed from the"
    warn "Cloudflare dashboard? Then the ingress lives in Zero Trust -> Networks"
    warn "-> Tunnels -> Public Hostnames, and editing a file here does nothing."
  elif grep -q "$DOMAIN" "$CF_CONF"; then
    ok "$DOMAIN is routed in $CF_CONF"
  else
    warn "$DOMAIN is NOT routed in $CF_CONF. Add ABOVE the catch-all:"
    printf '        - hostname: %s\n          service: http://127.0.0.1:8060\n' "$DOMAIN"
    warn "then: cloudflared --config $CF_CONF tunnel ingress validate && systemctl restart cloudflared"
  fi
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
  1. point $DOMAIN at $(hostname -I 2>/dev/null | awk '{print $1}') as an A record,
     DNS-only (grey cloud) — proxied, Let's Encrypt cannot validate the origin
  2. certbot --nginx -d $DOMAIN
     it adds the 443 block and turns port 80 into a redirect

The basic auth is not decoration. This page names every open port, every failed
unit and every unrotated credential in the estate. Until certbot has run, that
password crosses the network in the clear — do not use one you use elsewhere.
EOF
fi
