#!/usr/bin/env bash
# =============================================================================
#  kw-collect.sh  —  KW Group estate collector
#
#  READ-ONLY.  Nothing is created, changed, restarted, pruned or deleted.
#  Output is pre-redacted: no passwords, tokens, keys or connection-string
#  credentials are written to the dump.
#
#  Emits machine-parseable sections:   ===SECTION:NAME===   /   ---SUBSECTION---
#  Designed to be consumed by src/ingest/vps-dump.js in the kw-estate project.
#
#  USAGE
#    scp kw-collect.sh root@<server>:/root/
#    ssh root@<server> 'bash /root/kw-collect.sh'
#    scp root@<server>:/root/kw-collect-*.txt ./raw/
#
#  Then:  npm run ingest && npm run build
# =============================================================================

set -uo pipefail
HOST=$(hostname -s 2>/dev/null || echo unknown)
STAMP=$(date -u +%Y-%m-%dT%H%M)
OUT="/root/kw-collect-${HOST}-${STAMP}.txt"
SCHEMA="2.0"

# ---------------------------------------------------------------- redaction --
redact() {
  sed -E \
    -e 's#(mongodb(\+srv)?://[^:/]+):[^@]+@#\1:***REDACTED***@#g' \
    -e 's#(postgres(ql)?://[^:/]+):[^@]+@#\1:***REDACTED***@#g' \
    -e 's#(mysql://[^:/]+):[^@]+@#\1:***REDACTED***@#g' \
    -e 's#(redis://[^:/]*):[^@]+@#\1:***REDACTED***@#g' \
    -e 's/(EAA[A-Za-z0-9_-]{15,})/***META_TOKEN***/g' \
    -e 's/(le_live_[A-Za-z0-9]+)/***CRATIO_KEY***/g' \
    -e 's/(sk-[A-Za-z0-9_-]{20,})/***OPENAI_KEY***/g' \
    -e 's/(AIza[A-Za-z0-9_-]{30,})/***GOOGLE_KEY***/g' \
    -e 's/(gh[pousr]_[A-Za-z0-9]{20,})/***GITHUB_TOKEN***/g' \
    -e 's/(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/***JWT***/g' \
    -e 's/(-----BEGIN [A-Z ]*PRIVATE KEY-----)/***PRIVATE_KEY_BLOCK***/g' \
    -e 's/((PASSWORD|PASSWD|PWD|SECRET|TOKEN|API_?KEY|APIKEY|ACCESS_TOKEN|REFRESH_TOKEN|PRIVATE_KEY|VERIFY_TOKEN|ENCRYPTION_KEY|CLIENT_SECRET|JWT_SECRET|CRON_SECRET)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"']?)[^"'"'"'[:space:],}]{4,}/\1***REDACTED***/gI' \
    -e 's/(--password[= ])[^[:space:]]+/\1***REDACTED***/g' \
    -e 's/(Authorization:[[:space:]]*Bearer[[:space:]]+)[^[:space:]"'"'"']+/\1***REDACTED***/gI' \
    -e 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
    -e 's/\x1b\[[0-9]*~//g'
}
sec()  { printf '\n===SECTION:%s===\n' "$1"; }
sub()  { printf '\n---%s---\n' "$1"; }
have() { command -v "$1" >/dev/null 2>&1; }

# =============================================================================
{
printf '===MANIFEST===\n'
printf 'schema=%s\n' "$SCHEMA"
printf 'collected_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf 'hostname=%s\n' "$(hostname -f 2>/dev/null || hostname)"
printf 'collector=kw-collect.sh\n'

# ------------------------------------------------------------------- HOST ----
sec HOST
sub hostnamectl;  hostnamectl 2>/dev/null
sub uname;        uname -a
sub uptime;       uptime
sub os_release;   grep -E '^(NAME|VERSION)=' /etc/os-release 2>/dev/null
sub timezone;     timedatectl 2>/dev/null | head -4

# ------------------------------------------------------------- CPU_MEM_DISK --
sec CPU_MEM_DISK
sub nproc;        nproc
sub cpu_model;    lscpu 2>/dev/null | grep -E '^(Model name|CPU\(s\)|Thread|Core|Vendor ID)'
sub memory;       free -h
sub swap;         swapon --show 2>/dev/null || echo "no swap"
sub disk;         df -h -x tmpfs -x devtmpfs 2>/dev/null
sub inodes;       df -i -x tmpfs -x devtmpfs 2>/dev/null | head -5
sub top_dirs;     du -h / --max-depth=2 2>/dev/null | sort -hr | head -25
sub big_files;    find / -xdev -type f -size +200M -exec ls -lh {} \; 2>/dev/null \
                    | awk '{print $5"\t"$9}' | sort -hr | head -25

# ---------------------------------------------------------------- NETWORK ----
sec NETWORK
sub interfaces;   ip -br a 2>/dev/null
sub routes;       ip route 2>/dev/null
sub listening;    ss -tulnp 2>/dev/null
sub ufw;          ufw status verbose 2>/dev/null || echo "ufw not installed"
sub iptables_pol; iptables -L -n 2>/dev/null | grep -E '^Chain (INPUT|FORWARD|OUTPUT)'
sub fail2ban;     { fail2ban-client status 2>/dev/null; \
                    for j in $(fail2ban-client status 2>/dev/null | sed -n 's/.*Jail list:\s*//p' | tr ',' ' '); do
                      echo "-- jail $j --"; fail2ban-client status "$j" 2>/dev/null; done; } || echo "fail2ban not installed"

# ------------------------------------------------------------------- SSH -----
sec SSH
sub effective;    sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|port|permitemptypasswords|maxauthtries|x11forwarding)'
sub config_files; grep -rn -E '^(PermitRootLogin|PasswordAuthentication|PubkeyAuthentication|Port)' \
                    /etc/ssh/sshd_config /etc/ssh/sshd_config.d/ 2>/dev/null
sub recent_ok;    grep "Accepted" /var/log/auth.log 2>/dev/null | tail -15
sub failed_count; printf 'failed_password_current_log=%s\n' "$(grep -c 'Failed password' /var/log/auth.log 2>/dev/null || echo 0)"
sub top_attackers; lastb 2>/dev/null | awk '{print $3}' | grep -E '^[0-9]+\.' | sort | uniq -c | sort -rn | head -10

# --------------------------------------------------------------- SERVICES ----
sec SERVICES
sub running;      systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null
sub enabled;      systemctl list-unit-files --state=enabled --no-pager --no-legend 2>/dev/null | grep '\.service'
sub failed;       systemctl --failed --no-pager --no-legend 2>/dev/null
sub unit_details
for f in /etc/systemd/system/*.service; do
  [ -e "$f" ] || continue
  printf '\n==unit:%s==\n' "$(basename "$f")"
  grep -E '^(Description|WorkingDirectory|ExecStart|User|Group|Restart|EnvironmentFile)=' "$f" 2>/dev/null
done
sub timers;       systemctl list-timers --all --no-pager --no-legend 2>/dev/null | head -20

# ----------------------------------------------------------------- DOCKER ----
sec DOCKER
if have docker; then
  sub version;      docker version --format '{{.Server.Version}}' 2>/dev/null
  sub containers;   docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}\t{{.CreatedAt}}' 2>/dev/null
  sub images;       docker images --format '{{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}' 2>/dev/null
  sub system_df;    docker system df 2>/dev/null
  sub volumes;      docker volume ls --format '{{.Name}}' 2>/dev/null
  sub volume_users
  for v in $(docker volume ls -q 2>/dev/null); do
    u=$(docker ps -a --filter volume="$v" --format '{{.Names}}' 2>/dev/null | tr '\n' ',' | sed 's/,$//')
    printf '%s\t%s\n' "$v" "${u:-ORPHAN}"
  done
  sub compose;      docker compose ls 2>/dev/null
  sub stats;        docker stats --no-stream --format '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.BlockIO}}' 2>/dev/null
else
  echo "docker not installed"
fi

# ------------------------------------------------------------------ NGINX ----
sec WEB
if have nginx; then
  sub version;      nginx -v 2>&1
  sub vhosts;       nginx -T 2>/dev/null | grep -E 'server_name|proxy_pass|listen |root ' | sed 's/^[[:space:]]*//'
  sub sites_enabled; ls -la /etc/nginx/sites-enabled/ 2>/dev/null
  sub not_symlinks; find /etc/nginx/sites-enabled/ -maxdepth 1 -type f 2>/dev/null
else
  echo "nginx not installed"
fi
sub certs;        certbot certificates 2>/dev/null | grep -E 'Certificate Name|Domains|Expiry Date' || echo "certbot not available"
sub cloudflared;  cat /etc/cloudflared/config.yml 2>/dev/null || echo "no cloudflared config"

# -------------------------------------------------------------- DATABASES ----
sec DATABASES
for s in mysql mariadb postgresql redis-server mongod; do
  printf '%s=%s\n' "$s" "$(systemctl is-active "$s" 2>/dev/null || echo absent)"
done
sub postgres_dbs
if have psql && systemctl is-active postgresql >/dev/null 2>&1; then
  su - postgres -c "psql -lqt" 2>/dev/null | cut -d'|' -f1,7 | sed '/^\s*$/d'
fi
sub mongo_collections
MPY=/var/www/Dashborad_Overview/venv/bin/python
MURI=$(grep -oP 'MONGO_URI\s*=\s*"\K[^"]+' /var/www/Dashborad_Overview/main.py 2>/dev/null)
if [ -x "$MPY" ] && [ -n "$MURI" ]; then
  MONGO_URI="$MURI" "$MPY" - <<'PY' 2>/dev/null
import os
from pymongo import MongoClient
try:
    c = MongoClient(os.environ["MONGO_URI"], serverSelectionTimeoutMS=5000)
    for dbname in c.list_database_names():
        if dbname in ("admin","local","config"): continue
        db = c[dbname]
        for coll in db.list_collection_names():
            print(f"{dbname}\t{coll}\t{db[coll].estimated_document_count()}")
except Exception as e:
    print("mongo_error\t"+str(e)[:120])
PY
else
  echo "mongo client path not found"
fi

# ------------------------------------------------------------------- N8N -----
sec N8N
N8NC=$(docker ps --format '{{.Names}}' 2>/dev/null | grep -iE 'n8n' | grep -v traefik | head -1)
if [ -n "${N8NC:-}" ]; then
  printf 'container=%s\n' "$N8NC"
  sub all_workflows
  docker exec "$N8NC" n8n list:workflow 2>/dev/null | grep -E '^[A-Za-z0-9_-]+\|'
  sub active_workflows
  docker exec "$N8NC" n8n list:workflow --active=true 2>/dev/null | grep -E '^[A-Za-z0-9_-]+\|'
  sub db_size
  docker exec "$N8NC" sh -c 'ls -l /home/node/.n8n/database.sqlite 2>/dev/null | awk "{print \$5}"' 2>/dev/null
  sub data_dir
  docker exec "$N8NC" sh -c 'ls -lh /home/node/.n8n/ 2>/dev/null' 2>/dev/null
else
  echo "no n8n container"
fi

# -------------------------------------------------------------- PROJECTS ----
sec PROJECTS
sub opt;          ls -la /opt 2>/dev/null
sub var_www;      ls -la /var/www 2>/dev/null
sub home;         ls -la /home 2>/dev/null
sub root_dir;     ls -la /root 2>/dev/null
sub sizes;        du -sh /opt/* /var/www/* /home/* 2>/dev/null | sort -hr | head -25
sub git_repos;    find /opt /var/www /home /root -maxdepth 4 -name '.git' -type d 2>/dev/null | sed 's#/.git$##'
sub git_remotes
for g in $(find /opt /var/www -maxdepth 3 -name '.git' -type d 2>/dev/null | sed 's#/.git$##'); do
  printf '%s\t%s\n' "$g" "$(git -C "$g" remote get-url origin 2>/dev/null || echo none)"
done
sub env_files;    find /opt /var/www -maxdepth 3 -name '.env' -o -maxdepth 3 -name '*.env' 2>/dev/null
sub stale_files;  find /var/www /opt /etc/nginx -maxdepth 3 \
                    \( -name '*.bak*' -o -name '*.old' -o -name '*.orig' \) 2>/dev/null

# ------------------------------------------------------------------ CRON -----
sec CRON
sub root_crontab; crontab -l 2>/dev/null
sub user_crontabs
for u in $(cut -f1 -d: /etc/passwd); do
  o=$(crontab -u "$u" -l 2>/dev/null)
  [ -n "$o" ] && { printf '==user:%s==\n' "$u"; echo "$o"; }
done
sub cron_d
for f in /etc/cron.d/*; do [ -e "$f" ] || continue; printf '==%s==\n' "$f"; cat "$f" 2>/dev/null; done

# ------------------------------------------------------------------ LOGS -----
sec LOGS
sub journal_size;  journalctl --disk-usage 2>/dev/null
sub var_log_total; du -sh /var/log 2>/dev/null
sub largest_logs;  ls -lhS /var/log 2>/dev/null | head -12
sub oversized;     find /var/log -type f -size +100M -exec ls -lh {} \; 2>/dev/null | awk '{print $5"\t"$9}'
sub recent_errors; journalctl -p err -n 15 --no-pager 2>/dev/null

# --------------------------------------------------------------- PACKAGES ----
sec PACKAGES
sub running_kernel;   uname -r
sub installed_kernels; dpkg -l 'linux-image-*' 2>/dev/null | awk '/^ii/{print $2}'
sub reboot_required;  [ -f /var/run/reboot-required ] && cat /var/run/reboot-required || echo "no"
sub apt_cache;        du -sh /var/cache/apt 2>/dev/null
sub upgradable;       apt list --upgradable 2>/dev/null | grep -c upgradable

printf '\n===END===\n'
} 2>&1 | redact | tee "$OUT" >/dev/null

# ---------------------------------------------------------------- summary ----
echo "Collected: $OUT"
echo "Size     : $(du -h "$OUT" 2>/dev/null | cut -f1)"
echo "Lines    : $(wc -l < "$OUT")"
echo "Sections : $(grep -c '^===SECTION:' "$OUT")"
echo
echo "Leak check (should all be 0):"
LEAKS=0
for p in 'mongodb://[^:]*:[^*@]' 'sk-[A-Za-z0-9]{20}' 'EAA[A-Za-z0-9]{15}' 'le_live_[A-Za-z0-9]' 'eyJ[A-Za-z0-9_-]{8}\.'; do
  n=$(grep -Ec "$p" "$OUT" 2>/dev/null); n=${n:-0}
  LEAKS=$((LEAKS + n))
  printf '  %-34s %s\n' "$p" "$n"
done
echo
if [ "$LEAKS" -eq 0 ]; then echo "PASS — safe to transfer."
else echo "FAIL — $LEAKS unredacted match(es). Do NOT send this file; report the pattern."; fi
echo
echo "Next: scp root@$(hostname -I 2>/dev/null | awk '{print $1}'):$OUT ./raw/"
