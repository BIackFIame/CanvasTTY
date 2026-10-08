#!/usr/bin/env bash
set -Eeuo pipefail

if [[ "${EUID}" -ne 0 ]]; then
  echo "Run this script with sudo." >&2
  exit 1
fi

package_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
target=/opt/canvastty-reports/collector.mjs
expected=5b657e402480e180675168d6fd07bd94094f5ee63de296af5a1c005ab602b34c
current="$(sha256sum "$target" | cut -d ' ' -f 1)"
proposed="$(sha256sum "$package_directory/collector.mjs" | cut -d ' ' -f 1)"
if [[ "$current" == "$proposed" ]]; then
  echo "Collector source is already up to date."
  exit 0
fi
if [[ "$current" != "$expected" ]]; then
  echo "Collector has changed since the reviewed deployment; refusing to overwrite it." >&2
  exit 1
fi

/usr/bin/node --check "$package_directory/collector.mjs"
backup_directory="$(mktemp -d /var/backups/canvastty-reports-collector-20261003-XXXXXX)"
cp -p "$target" "$backup_directory/collector.mjs"

rollback() {
  local status=$?
  trap - ERR
  cp -p "$backup_directory/collector.mjs" "$target"
  systemctl restart canvastty-reports.service || true
  echo "Update failed; restored collector from $backup_directory" >&2
  exit "$status"
}
trap rollback ERR
install -o root -g root -m 0644 "$package_directory/collector.mjs" "$target"
systemctl restart canvastty-reports.service
curl --silent --show-error --fail --retry 5 --retry-connrefused --retry-delay 1 http://127.0.0.1:8787/health
systemctl is-active --quiet canvastty-reports.service
trap - ERR
printf '\nCollector updated. Backup: %s\n' "$backup_directory"
