#!/usr/bin/env python3
"""
Numax Studio - local visual editing server.

Serves the real site from this repo and injects an editing overlay ON THE FLY.
index.html on disk is NEVER modified by serving - only by an explicit Save.
studio.js is never referenced from index.html, so nothing here reaches the
live site even though the folder is committed.

Run:  python studio/studio_server.py       (then open http://localhost:8731/)
"""

import http.server
import html as htmllib
import json
import os
import re
import shutil
import socketserver
import sys
import time
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
INDEX = os.path.join(ROOT, 'index.html')
REQUESTS = os.path.join(HERE, 'requests.md')
BACKUPS = os.path.join(HERE, 'backups')

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8731

def read_text(path):
    """newline='' on BOTH read and write, always. Python's default text mode
    rewrites every line ending on Windows, which would turn a one-line tweak
    into a diff touching all 1940 lines of index.html. This keeps whatever
    the file already uses, byte for byte."""
    with open(path, encoding='utf-8', newline='') as fh:
        return fh.read()


def write_text(path, text):
    with open(path, 'w', encoding='utf-8', newline='') as fh:
        fh.write(text)


VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link',
        'meta', 'param', 'source', 'track', 'wbr'}
# Never stamp these - either invisible, or stamping them is meaningless.
NO_STAMP = {'script', 'style', 'br', 'meta', 'link', 'title', 'head', 'html', 'body'}

BEGIN = '/* ==== NUMAX STUDIO EDITS - managed by studio/studio_server.py ==== */'
END = '/* ==== END NUMAX STUDIO EDITS ==== */'


# ----------------------------------------------------------------------
# HTML scanner: exact character offsets for every element in the file.
# ----------------------------------------------------------------------
class Node:
    __slots__ = ('tag', 'start', 'tag_end', 'inner_end', 'end', 'parent',
                 'children', 'in_svg', 'attrs', 'closed', 'void', 'sx')

    def __init__(self, tag, start, tag_end, parent, in_svg, attrs):
        self.tag = tag
        self.start = start
        self.tag_end = tag_end
        self.inner_end = tag_end
        self.end = tag_end
        self.parent = parent
        self.children = []
        self.in_svg = in_svg
        self.attrs = dict(attrs)
        self.closed = False
        self.void = False
        self.sx = None


class Scanner(HTMLParser):
    def __init__(self, src):
        super().__init__(convert_charrefs=False)
        self.src = src
        # Count newlines only - exactly what HTMLParser's getpos() counts.
        # splitlines() also breaks on vertical tab, form feed and U+2028,
        # which would silently desync every offset in a file holding one.
        self.line_off = [0]
        pos = 0
        for part in src.split('\n'):
            pos += len(part) + 1
            self.line_off.append(pos)
        self.nodes = []
        self.stack = []

    def off(self):
        line, col = self.getpos()
        return self.line_off[line - 1] + col

    def _in_svg(self):
        return any(n.tag == 'svg' for n in self.stack)

    def _make(self, tag, attrs, void):
        start = self.off()
        raw = self.get_starttag_text() or ''
        tag_end = start + len(raw)
        parent = self.stack[-1] if self.stack else None
        n = Node(tag, start, tag_end, parent, self._in_svg(), attrs)
        if parent is not None:
            parent.children.append(n)
        self.nodes.append(n)
        if void:
            n.void = True
            n.closed = True
            n.inner_end = tag_end
            n.end = tag_end
        else:
            self.stack.append(n)
        return n

    def handle_starttag(self, tag, attrs):
        self._make(tag, attrs, tag in VOID)

    def handle_startendtag(self, tag, attrs):
        self._make(tag, attrs, True)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        start = self.off()
        gt = self.src.find('>', start)
        end = (gt + 1) if gt != -1 else start
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i].tag == tag:
                # Anything still open above this was never closed - mark unusable.
                for orphan in self.stack[i + 1:]:
                    orphan.inner_end = start
                    orphan.end = start
                    orphan.closed = False
                node = self.stack[i]
                node.inner_end = start
                node.end = end
                node.closed = True
                del self.stack[i:]
                return


def scan(src):
    s = Scanner(src)
    s.feed(src)
    s.close()
    body = next((n for n in s.nodes if n.tag == 'body'), None)
    sx = 0
    index = {}
    for n in s.nodes:
        if n.tag in NO_STAMP or (n.in_svg and n.tag != 'svg'):
            continue
        anc, inside_body = n.parent, False
        while anc is not None:
            if anc is body:
                inside_body = True
                break
            anc = anc.parent
        if not inside_body:
            continue
        n.sx = sx
        index[sx] = n
        sx += 1
    return s, index


def describe(src, index):
    """The per-element facts the overlay needs, keyed by data-sx."""
    out = {}
    for sx, n in index.items():
        inner = src[n.tag_end:n.inner_end] if n.closed and not n.void else ''
        # ci: this element's index among ALL of its parent's element children
        # (including ones never stamped, e.g. <br>). nk: how many there are.
        # The overlay needs both to express a reorder the file can apply.
        ci = None
        if n.parent is not None:
            try:
                ci = n.parent.children.index(n)
            except ValueError:
                ci = None
        out[str(sx)] = {
            'tag': n.tag,
            'editable': bool(n.closed and not n.void),
            'textOnly': bool(n.closed and not n.void and '<' not in inner),
            'parent': n.parent.sx if (n.parent is not None and n.parent.sx is not None) else None,
            'ci': ci,
            'nk': len(n.children),
        }
    return out


def build_page():
    src = read_text(INDEX)
    s, index = scan(src)
    inserts = []
    for sx, n in index.items():
        inserts.append((n.start + 1 + len(n.tag), ' data-sx="%d"' % sx))
    out = src
    for pos, text in sorted(inserts, reverse=True):
        out = out[:pos] + text + out[pos:]
    boot = (
        '<script>window.__SX__=%s;window.__STUDIO_EDITS__=%s;</script>\n'
        '<script src="/studio/studio.js"></script>\n'
    ) % (json.dumps(describe(src, index), separators=(',', ':')),
         json.dumps(load_edits(), separators=(',', ':')))
    lower = out.lower()
    cut = lower.rfind('</body>')
    if cut == -1:
        out += boot
    else:
        out = out[:cut] + boot + out[cut:]
    return out


# ----------------------------------------------------------------------
# Saving
# ----------------------------------------------------------------------
def read_block(src):
    """The managed block inside index.html IS the record of every Studio
    tweak - deliberately not a sidecar file. A sidecar can go missing (fresh
    clone, stray delete) and the next save would then quietly wipe the block
    and undo everything. Reading it back from the file cannot drift."""
    m = re.search(re.escape(BEGIN) + r'.*?' + re.escape(END), src, re.S)
    if not m:
        return {}
    edits = {}
    for sel, body in re.findall(r'\n\s*([^{\n/][^{\n]*?)\{([^}]*)\}', m.group(0)):
        props = {}
        for decl in body.split(';'):
            if ':' in decl:
                k, v = decl.split(':', 1)
                if k.strip():
                    props[k.strip()] = v.strip()
        if props:
            edits[sel.strip()] = props
    return edits


def load_edits():
    try:
        return read_block(read_text(INDEX))
    except Exception:
        return {}


def css_block(edits, nl='\n'):
    live = {s: p for s, p in edits.items() if p}
    if not live:
        return ''
    lines = [BEGIN,
             '/* Written by the Studio overlay. Delete this whole block to drop',
             '   every visual tweak it has made, in one go. */']
    for sel in sorted(live):
        props = live[sel]
        body = ' '.join('%s:%s;' % (k, v) for k, v in sorted(props.items()))
        lines.append('  %s{ %s }' % (sel, body))
    lines.append(END)
    return nl.join(lines) + nl


def write_css(src, edits):
    # Match the file's own line endings, or the block lands as a patch of
    # bare LF inside a CRLF file and every tool downstream notices.
    nl = '\r\n' if '\r\n' in src else '\n'
    pattern = re.compile(re.escape(BEGIN) + r'.*?' + re.escape(END) + r'(\r?\n)?', re.S)
    src = pattern.sub('', src)
    block = css_block(edits, nl)
    if not block:
        return src
    cut = src.find('</style>')
    if cut == -1:
        return src
    return src[:cut] + block + src[cut:]


def render(node, src, texts, orders):
    """Re-emit one element's source with its own and its descendants' edits."""
    out = src[node.start:node.tag_end]
    if node.void or not node.closed:
        return out
    key = str(node.sx)
    if node.sx is not None and key in texts:
        out += htmllib.escape(texts[key], quote=False)
    else:
        kids = node.children
        order = None
        if node.sx is not None and key in orders:
            want = orders[key]
            if sorted(want) == list(range(len(kids))):
                order = want
        # Preserve the text/comment gaps positionally; permute only elements.
        gaps, cursor = [], node.tag_end
        for k in kids:
            gaps.append(src[cursor:k.start])
            cursor = k.end
        gaps.append(src[cursor:node.inner_end])
        seq = [kids[i] for i in order] if order else kids
        for i, kid in enumerate(seq):
            out += gaps[i] + render(kid, src, texts, orders)
        out += gaps[-1]
    out += src[node.inner_end:node.end]
    return out


def apply_structure(src, texts, orders):
    if not texts and not orders:
        return src, 0, 0
    s, index = scan(src)
    touched = set()
    for key in list(texts) + list(orders):
        try:
            sx = int(key)
        except ValueError:
            continue
        if sx in index and index[sx].closed:
            touched.add(sx)
    if not touched:
        return src, 0, 0
    # Only splice the outermost touched elements; render() handles the rest.
    tops = []
    for sx in touched:
        n, nested = index[sx], False
        anc = n.parent
        while anc is not None:
            if anc.sx in touched:
                nested = True
                break
            anc = anc.parent
        if not nested:
            tops.append(n)
    for n in sorted(tops, key=lambda x: x.start, reverse=True):
        src = src[:n.start] + render(n, src, texts, orders) + src[n.end:]
    return src, len(texts), len(orders)


def backup(src):
    os.makedirs(BACKUPS, exist_ok=True)
    name = 'index.%s.html' % time.strftime('%Y-%m-%d_%H%M%S')
    write_text(os.path.join(BACKUPS, name), src)
    names = sorted(n for n in os.listdir(BACKUPS) if n.endswith('.html'))
    for old in names[:-40]:
        try:
            os.remove(os.path.join(BACKUPS, old))
        except OSError:
            pass
    return name


def do_save(payload):
    src = read_text(INDEX)
    tag = backup(src)
    edits = payload.get('css') or {}
    texts = payload.get('text') or {}
    orders = payload.get('orders') or {}
    src, nt, no = apply_structure(src, texts, orders)
    src = write_css(src, edits)
    write_text(INDEX, src)
    return {'ok': True, 'backup': tag, 'rules': len(edits), 'text': nt, 'moves': no}


def do_undo():
    names = sorted(n for n in os.listdir(BACKUPS)) if os.path.isdir(BACKUPS) else []
    names = [n for n in names if n.endswith('.html')]
    if not names:
        return {'ok': False, 'error': 'Nothing to undo - no saves yet this session.'}
    last = names[-1]
    shutil.copyfile(os.path.join(BACKUPS, last), INDEX)
    os.remove(os.path.join(BACKUPS, last))
    return {'ok': True, 'restored': last}


def do_note(payload):
    where = payload.get('where') or 'somewhere'
    sel = payload.get('selector') or ''
    text = (payload.get('text') or '').strip()
    if not text:
        return {'ok': False, 'error': 'Empty note.'}
    stamp = time.strftime('%Y-%m-%d %H:%M')
    line = '\n## %s\n\n**Where:** %s  \n**Selector:** `%s`\n\n%s\n' % (stamp, where, sel, text)
    head = ''
    if not os.path.exists(REQUESTS):
        head = ('# Studio requests\n\n'
                'Things pinned in Studio that need real code, not just styling.\n'
                'Claude reads this file; delete an entry once it is done.\n')
    else:
        head = read_text(REQUESTS)
    write_text(REQUESTS, head + line)
    return {'ok': True}


def do_notes():
    try:
        return {'ok': True, 'text': read_text(REQUESTS)}
    except Exception:
        return {'ok': True, 'text': ''}


# ----------------------------------------------------------------------
# HTTP
# ----------------------------------------------------------------------
class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, fmt, *args):
        if '__studio' in (self.path or ''):
            sys.stderr.write('studio: %s\n' % (fmt % args))

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        super().end_headers()

    def _json(self, obj, code=200):
        raw = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        path = self.path.split('?')[0]
        if path in ('/', '/index.html'):
            try:
                raw = build_page().encode('utf-8')
            except Exception as exc:
                self._json({'ok': False, 'error': repr(exc)}, 500)
                return
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
            return
        if path == '/__studio/notes':
            self._json(do_notes())
            return
        super().do_GET()

    def do_POST(self):
        path = self.path.split('?')[0]
        try:
            n = int(self.headers.get('Content-Length') or 0)
            payload = json.loads(self.rfile.read(n).decode('utf-8') or '{}')
        except Exception as exc:
            self._json({'ok': False, 'error': 'Bad request: %r' % exc}, 400)
            return
        try:
            if path == '/__studio/save':
                self._json(do_save(payload))
            elif path == '/__studio/undo':
                self._json(do_undo())
            elif path == '/__studio/note':
                self._json(do_note(payload))
            else:
                self._json({'ok': False, 'error': 'Unknown endpoint'}, 404)
        except Exception as exc:
            self._json({'ok': False, 'error': repr(exc)}, 500)


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


def port_taken(port):
    """A plain `python -m http.server` binds 0.0.0.0 and would shadow us on
    localhost while we happily bind 127.0.0.1 - so check before serving,
    or Studio looks broken when it is simply not the one being reached."""
    import socket
    for family, addr in ((socket.AF_INET, '0.0.0.0'), (socket.AF_INET6, '::')):
        s = socket.socket(family, socket.SOCK_STREAM)
        try:
            s.bind((addr, port))
        except OSError:
            return True
        finally:
            s.close()
    return False


if __name__ == '__main__':
    os.makedirs(BACKUPS, exist_ok=True)
    if port_taken(PORT):
        print('Port %d is already in use - something else is serving there' % PORT)
        print('(most likely a leftover "python -m http.server %d").' % PORT)
        print('Close that window, or start Studio on another port:')
        print('    python studio/studio_server.py %d' % (PORT + 1))
        sys.exit(1)
    print('Numax Studio')
    print('  serving %s' % ROOT)
    print('  open    http://localhost:%d/' % PORT)
    print('  stop    Ctrl+C')
    try:
        Server(('127.0.0.1', PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print('\nstopped.')
