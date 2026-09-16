#!/usr/bin/env python3
"""Stamp a content version onto every local script index.html loads.

Why this exists
---------------
GitHub Pages serves everything with `Cache-Control: max-age=600` and there is
no way to change that from inside the repo.  The page used to load its scripts
by bare name (`./app.js`), so a browser that had fetched app.js before a deploy
would happily keep serving the OLD file for up to ten minutes after the new one
went live -- and a plain refresh does not always throw it away.  That is the
whole of "I pushed it but the live site still looks old".

The fix is a query string the browser treats as part of the identity of the
file: `./app.js?v=1f3c9a02`.  The value is a hash of that file's own contents,
so a file that did not change keeps its stamp (and stays cached, which is the
point), and a file that did change gets a new one and is re-fetched at once.

The hash is taken over the file with CR characters removed, so a checkout with
different line-ending settings produces the same stamp rather than showing
index.html as modified for no reason.

Usage
-----
    python stamp.py            # rewrite index.html if any stamp is stale
    python stamp.py --check    # report only, exit 1 if a stamp is stale

Run it before committing.  The repo's pre-commit hook does this automatically;
this is also safe to run by hand any number of times.
"""

import hashlib
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
INDEX = HERE / 'index.html'

# Matches  src="./app.js"  and  src="./app.js?v=abc123"  and nothing else --
# an absolute URL (the Google sign-in script) has no "./" and is left alone.
TAG = re.compile(r'(<script\s+src="\./)([A-Za-z0-9._-]+\.js)(\?v=[0-9a-f]+)?(")')


def read_text(p):
    """Read preserving the file's own line endings (Windows text mode rewrites
    them, and index.html is CRLF)."""
    with open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()


def write_text(p, s):
    with open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)


def stamp_for(name):
    p = HERE / name
    if not p.exists():
        return None
    data = p.read_bytes().replace(b'\r', b'')
    return hashlib.sha256(data).hexdigest()[:8]


def main(argv):
    check_only = '--check' in argv
    src = read_text(INDEX)

    missing = []
    changed = []

    def sub(m):
        open_, name, old, close = m.group(1), m.group(2), m.group(3), m.group(4)
        h = stamp_for(name)
        if h is None:
            missing.append(name)
            return m.group(0)
        new = '?v=' + h
        if old != new:
            changed.append((name, (old or '?v=(none)')[3:], h))
        return open_ + name + new + close

    out = TAG.sub(sub, src)

    if missing:
        print('ERROR: index.html loads a script that is not in this folder:')
        for n in missing:
            print('  ' + n)
        return 2

    count = len(TAG.findall(src))
    if not changed:
        print('stamp: %d scripts, all stamps current.' % count)
        return 0

    for name, old, new in changed:
        print('stamp: %-26s %s -> %s' % (name, old, new))

    if check_only:
        print('stamp: %d stale (run "python stamp.py" to fix).' % len(changed))
        return 1

    write_text(INDEX, out)
    print('stamp: index.html updated (%d of %d scripts).' % (len(changed), count))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
