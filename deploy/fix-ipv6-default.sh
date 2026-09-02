#!/usr/bin/env bash
#
# Stop one vhost answering for every hostname over IPv6.
#
#   sudo bash /opt/kw-estate/deploy/fix-ipv6-default.sh
#   sudo bash /opt/kw-estate/deploy/fix-ipv6-default.sh --dry-run
#
# THE PROBLEM
#
# nginx picks a default server per listen address. If one vhost carries
# `listen [::]:443` and its neighbours do not, that vhost becomes the default
# for ALL IPv6 traffic and serves ITS certificate for every hostname on the box.
#
# It has happened twice here. First kw-estate — my fault, it shipped with
# `listen [::]:80` and certbot mirrored it to 443. Then fal.leadq.co.in, very
# likely copied from that same template. Both times the visible symptom was
# somewhere else entirely: n8n's UI throwing certificate warnings, its ACME
# renewal 404ing, the editor reporting "lost connection to the server", and the
# nightly report going silent — while n8n itself was perfectly healthy and
# answering 200 over IPv4 the whole time.
#
# THE FIX
#
# Consistency. Either every vhost listens on IPv6 or none does. This removes
# IPv6 listeners, which is the safe direction: nothing on this box has an
# AAAA-only client, and IPv4 already serves every hostname correctly.
#
# It backs up what it edits, refuses to reload on a bad config, restores if the
# test fails, and then PROVES the result by asking each hostname over IPv6 which
# certificate it presents.

set -euo pipefail

DRY=${1:-}
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/root/nginx-ipv6-fix-$STAMP

say()  { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
ok()   { printf '    \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '    \033[33m!\033[0m %s\n' "$*"; }
die()  { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run as root"
command -v nginx >/dev/null || die "nginx not found"

say "Which vhosts listen on IPv6"
mapfile -t FILES < <(grep -ls "listen[[:space:]]*\[::\]" /etc/nginx/sites-enabled/* 2>/dev/null || true)

if [ ${#FILES[@]} -eq 0 ]; then
  ok "none — nothing to fix"
  exit 0
fi
for f in "${FILES[@]}"; do printf '    %s\n' "$(basename "$f")"; done
printf '    %s of %s vhosts\n' "${#FILES[@]}" "$(ls /etc/nginx/sites-enabled/ | wc -l)"

if [ "$DRY" = "--dry-run" ]; then
  warn "dry run — would remove the listen [::] lines from the files above"
  exit 0
fi

say "Backing up to $BACKUP"
mkdir -p "$BACKUP"
for f in "${FILES[@]}"; do cp -L "$f" "$BACKUP/$(basename "$f")"; done
ok "$(ls "$BACKUP" | wc -l) file(s) saved"

say "Removing the IPv6 listeners"
for f in "${FILES[@]}"; do
  # -L: sites-enabled entries are usually symlinks; edit the real file.
  real=$(readlink -f "$f")
  sed -i '/listen[[:space:]]*\[::\]/d' "$real"
  ok "$(basename "$real")"
done

say "Testing the config"
if ! nginx -t 2>&1 | sed 's/^/    /'; then
  warn "nginx -t failed — restoring and leaving nginx untouched"
  for f in "${FILES[@]}"; do cp "$BACKUP/$(basename "$f")" "$(readlink -f "$f")"; done
  die "restored from $BACKUP. Nothing was reloaded."
fi
systemctl reload nginx
ok "reloaded"

say "Proving it: which certificate does each hostname serve over IPv6?"
BAD=0
nginx -T 2>/dev/null \
  | sed -n 's/^[[:space:]]*server_name[[:space:]]\+\([^;]*\);.*/\1/p' \
  | tr ' ' '\n' | grep -E '^[a-z0-9.-]+\.[a-z]{2,}$' | sort -u | while read -r host; do
    cn=$(timeout 6 openssl s_client -6 -servername "$host" -connect "$host:443" </dev/null 2>/dev/null \
         | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//')
    if [ -z "$cn" ]; then
      printf '    %-42s no IPv6 listener (expected)\n' "$host"
    elif [ "$cn" = "$host" ]; then
      printf '    \033[32m✓\033[0m %-40s %s\n' "$host" "$cn"
    else
      printf '    \033[31m✗\033[0m %-40s serves %s\n' "$host" "$cn"
      BAD=1
    fi
  done

cat <<EOF

Done. If any line above is red, that hostname still gets somebody else's
certificate over IPv6 — re-run, or check for a listen [::] outside sites-enabled
(nginx.conf, conf.d/).

Browsers remember HSTS, so a host that was broken may still refuse after the
fix. Clear it at chrome://net-internals/#hsts -> Delete domain security policies.

Backup: $BACKUP
EOF
