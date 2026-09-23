#!/usr/bin/env python3
"""Consistent SQLite backups, including WAL, without stopping the app."""
import datetime
import os
import pathlib
import sqlite3

os.umask(0o077)
root = pathlib.Path('/var/backups/imstage')
root.mkdir(parents=True, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
for name, source in [('api', '/var/lib/imstage/api/imstage.db'), ('mcp', '/var/lib/imstage/mcp/mcp.sqlite')]:
    if not pathlib.Path(source).is_file():
        continue
    target = root / f'{name}-{stamp}.sqlite'
    with sqlite3.connect(f'file:{source}?mode=ro', uri=True) as src, sqlite3.connect(target) as dst:
        src.backup(dst)
        if dst.execute('PRAGMA integrity_check').fetchone()[0] != 'ok':
            raise RuntimeError(f'Backup integrity failed: {name}')
    for old in sorted(root.glob(f'{name}-*.sqlite'), reverse=True)[14:]:
        old.unlink()
    print(f'{name}: backup verified')
