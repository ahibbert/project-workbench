#!/usr/bin/env sh
# Verify a backup without writing to live application data.
set -eu

archive=${1:?usage: verify-panels-backup.sh /path/to/panels-data-*.tar.gz}
checksum="$archive.sha256"

test -f "$archive"
test -f "$checksum"
sha256sum -c "$checksum"
tar -tzf "$archive" | grep -q '^panel-pilot/'
tar -tzf "$archive" | grep -q '^books/cwa-config/'
tar -tzf "$archive" | grep -q '^books/cwa-library/'
printf '%s\n' "Backup contents and checksum verified: $archive"
