#!/usr/bin/env python3
"""OSSTagLab server: serves the browser app in web/, stores short
microphone captures (<id>.wav plus <id>.json sidecar) in recordings/,
keeps the club codebook in codebook.json (starting from codebook.example.json), and appends each tag the app
identifies to identifications.jsonl, next to the codebook.

Standard library only; runs on Python 3.9. Binds 127.0.0.1 only.

Usage: python3 server.py [--port 8765] [--recordings DIR] [--web DIR]
"""

import argparse
import datetime
import errno
import json
import os
import re
import shutil
import sys
import tempfile
import threading
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlsplit

HOST = '127.0.0.1'
DEFAULT_PORT = 8765
MAX_WAV_BYTES = 64 * 1024 * 1024
MAX_PATCH_BYTES = 1024 * 1024
MAX_CODEBOOK_BYTES = 1024 * 1024
MAX_IDENTIFICATION_BYTES = 64 * 1024
IDENTIFICATIONS_FILE = 'identifications.jsonl'
DEFAULT_CODEBOOK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'codebook.json')
# The clubs mapped on our own set of tags: what the app starts from until you save your own.
EXAMPLE_CODEBOOK_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'codebook.example.json')
# Seconds a connection may sit idle before it is dropped.
SOCKET_TIMEOUT_S = 30
SERVER_KEYS = ('id', 'file', 'savedAt', 'bytes')

ID_RE = re.compile(r'[0-9]{8}-[0-9]{6}-[0-9]{3}(?:-[0-9]+)?')
ID_BASE_LEN = len('YYYYMMDD-HHMMSS-mmm')

CONTENT_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wav': 'audio/wav',
    '.svg': 'image/svg+xml; charset=utf-8',
    '.png': 'image/png',
}


# The page loads only its own files. blob: covers the WAV download link and audio playback.
CONTENT_SECURITY_POLICY = ("default-src 'self'; media-src 'self' blob:; img-src 'self' blob: data:; "
                           "object-src 'none'; base-uri 'none'; frame-ancestors 'none'")


class ApiError(Exception):
    def __init__(self, status, message, headers=()):
        Exception.__init__(self, message)
        self.status = status
        self.message = message
        self.headers = list(headers)


def not_found():
    return ApiError(404, 'capture not found')


def is_valid_id(cid):
    return ID_RE.fullmatch(cid) is not None


def _reject_constant(name):
    raise ValueError('non-finite number %s is not allowed' % name)


def parse_json_object(raw, what):
    """Parse raw JSON (str or bytes) that must be an object; 400 otherwise."""
    try:
        obj = json.loads(raw, parse_constant=_reject_constant)
    except ValueError:
        raise ApiError(400, '%s is not valid JSON' % what)
    if not isinstance(obj, dict):
        raise ApiError(400, '%s must be a JSON object' % what)
    return obj


def empty_codebook():
    return {'version': 1, 'clubs': {}}


def codebook_revision(obj):
    """The save counter of a codebook document; a document without one is at revision 0."""
    return obj.get('revision', 0)


def check_codebook(obj):
    """Raise 400 unless obj is a codebook: version 1, a clubs object, a sane revision."""
    if type(obj.get('version')) is not int or obj['version'] != 1:
        raise ApiError(400, 'codebook version must be the integer 1')
    if not isinstance(obj.get('clubs'), dict):
        raise ApiError(400, 'codebook clubs must be a JSON object')
    revision = codebook_revision(obj)
    if type(revision) is not int or revision < 0:
        raise ApiError(400, 'codebook revision must be a non-negative integer')


def now_local():
    return datetime.datetime.now().astimezone()


def _sort_key(cid):
    """Sort key so that newer captures compare greater (suffix -N orders)."""
    base = cid[:ID_BASE_LEN]
    n = int(cid[ID_BASE_LEN + 1:]) if len(cid) > ID_BASE_LEN else 1
    return (base, n)


class CaptureStore(object):
    """Sidecar + WAV files in one directory. Writes are atomic (temp + replace)."""

    def __init__(self, root):
        self.root = root
        self._lock = threading.Lock()

    def _wav(self, cid):
        return os.path.join(self.root, cid + '.wav')

    def _json(self, cid):
        return os.path.join(self.root, cid + '.json')

    def _exists(self, cid):
        return os.path.exists(self._wav(cid)) or os.path.exists(self._json(cid))

    def _write_atomic(self, path, data):
        fd, tmp = tempfile.mkstemp(dir=self.root, prefix='.tmp-', suffix='.part')
        try:
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(tmp, path)
        except BaseException:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _read_meta(self, cid):
        """Sidecar dict for a complete capture (wav and valid json); else 404."""
        if not os.path.isfile(self._wav(cid)):
            raise not_found()
        try:
            with open(self._json(cid), 'rb') as handle:
                return parse_json_object(handle.read(), 'sidecar')
        except (OSError, ApiError):
            raise not_found()

    def list_captures(self):
        try:
            names = os.listdir(self.root)
        except OSError:
            return []
        found = []
        for name in names:
            if not name.endswith('.json'):
                continue
            cid = name[:-len('.json')]
            if not is_valid_id(cid):
                continue
            try:
                meta = self._read_meta(cid)
            except ApiError:
                continue
            found.append((_sort_key(cid), meta))
        found.sort(key=lambda item: item[0], reverse=True)
        return [meta for _, meta in found]

    def create(self, wav, meta):
        with self._lock:
            os.makedirs(self.root, exist_ok=True)
            now = now_local()
            base = now.strftime('%Y%m%d-%H%M%S') + '-%03d' % (now.microsecond // 1000)
            cid = base
            n = 2
            while self._exists(cid):
                cid = '%s-%d' % (base, n)
                n += 1
            stored = dict(meta)
            stored.update(
                id=cid,
                file=cid + '.wav',
                savedAt=now.isoformat(timespec='milliseconds'),
                bytes=len(wav),
            )
            self._write_atomic(self._wav(cid), wav)
            try:
                self._write_atomic(self._json(cid), json.dumps(stored).encode('utf-8'))
            except BaseException:
                try:
                    os.remove(self._wav(cid))
                except OSError:
                    pass
                raise
            return stored

    def patch(self, cid, changes):
        with self._lock:
            meta = self._read_meta(cid)
            for key, value in changes.items():
                if key not in SERVER_KEYS:
                    meta[key] = value
            self._write_atomic(self._json(cid), json.dumps(meta).encode('utf-8'))
            return meta

    def delete(self, cid):
        with self._lock:
            if not self._exists(cid):
                raise not_found()
            for path in (self._json(cid), self._wav(cid)):
                try:
                    os.remove(path)
                except FileNotFoundError:
                    pass

    def wav_path(self, cid):
        path = self._wav(cid)
        if not os.path.isfile(path):
            raise not_found()
        return path


class CodebookStore(object):
    """The club codebook: one JSON file, replaced atomically on every save.

    Until that file exists the store reads `example`, a read-only codebook shipped with the
    app, so a fresh checkout starts with clubs to look at. The first save writes `path`.
    Messages sent to the browser name files by basename only, never by full path.
    """

    def __init__(self, path, example=None):
        self.path = path
        self.example = example
        self._lock = threading.Lock()

    def _read_file(self, path):
        with open(path, 'rb') as handle:
            raw = handle.read()
        try:
            return parse_json_object(raw, 'codebook')
        except ApiError as err:
            raise ApiError(500, 'codebook file %s is corrupt: %s' % (os.path.basename(path), err.message))

    def _read_locked(self):
        for path in (self.path, self.example):
            if path is None:
                continue
            try:
                return self._read_file(path)
            except FileNotFoundError:
                continue
            except OSError as err:
                raise ApiError(500, 'cannot read codebook file %s: %s'
                               % (os.path.basename(path), err.strerror or err))
        return empty_codebook()

    def load(self):
        with self._lock:
            return self._read_locked()

    def save(self, codebook):
        """Store codebook if it was built from the stored revision; return what was stored.

        The stored document's revision is one more than the one it replaces, so a save
        built from a stale copy (another window saved in between) is refused with 409
        instead of silently undoing the other save. A file that cannot be read back is
        never replaced.
        """
        with self._lock:
            stored_revision = codebook_revision(self._read_locked())
            if type(stored_revision) is not int or stored_revision < 0:
                raise ApiError(500, 'codebook file %s has an invalid revision' % os.path.basename(self.path))
            if codebook_revision(codebook) != stored_revision:
                raise ApiError(409, 'the saved clubs were changed in another window; reload the page and save again')
            stored = dict(codebook, revision=stored_revision + 1)
            data = (json.dumps(stored, indent=2, sort_keys=True) + '\n').encode('utf-8')
            tmp = None
            try:
                directory = os.path.dirname(self.path)
                os.makedirs(directory, exist_ok=True)
                fd, tmp = tempfile.mkstemp(dir=directory, prefix='.codebook-', suffix='.tmp')
                with os.fdopen(fd, 'wb') as handle:
                    handle.write(data)
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(tmp, self.path)
            except OSError as err:
                if tmp is not None:
                    try:
                        os.unlink(tmp)
                    except OSError:
                        pass
                raise ApiError(500, 'could not write codebook file %s: %s'
                               % (os.path.basename(self.path), err.strerror or err))
            return stored


class IdentificationLog(object):
    """What the app identified, one JSON object per line, oldest first. Append only."""

    def __init__(self, path):
        self.path = path
        self._lock = threading.Lock()

    def append(self, entry):
        """Stamp entry with the time it was logged, append it, and return what was stored."""
        stored = dict(entry, loggedAt=now_local().isoformat(timespec='milliseconds'))
        line = (json.dumps(stored, sort_keys=True) + '\n').encode('utf-8')
        with self._lock:
            try:
                os.makedirs(os.path.dirname(self.path), exist_ok=True)
                with open(self.path, 'ab') as handle:
                    handle.write(line)
            except OSError as err:
                raise ApiError(500, 'could not write identification log %s: %s'
                               % (os.path.basename(self.path), err.strerror or err))
        return stored

    def entries(self):
        with self._lock:
            try:
                with open(self.path, 'rb') as handle:
                    lines = handle.read().splitlines()
            except FileNotFoundError:
                return []
            except OSError as err:
                raise ApiError(500, 'cannot read identification log %s: %s'
                               % (os.path.basename(self.path), err.strerror or err))
        try:
            return [json.loads(line, parse_constant=_reject_constant) for line in lines if line.strip()]
        except ValueError:
            raise ApiError(500, 'identification log %s is corrupt' % os.path.basename(self.path))


class CaptureHandler(BaseHTTPRequestHandler):
    server_version = 'OSSTagLab/1.0'
    timeout = SOCKET_TIMEOUT_S

    def version_string(self):
        return self.server_version

    def log_message(self, format, *args):
        # Silenced: only API calls are logged, by _dispatch.
        pass

    def send_response(self, code, message=None):
        self._status = code
        BaseHTTPRequestHandler.send_response(self, code, message)

    def do_GET(self):
        self._dispatch('GET')

    def do_POST(self):
        self._dispatch('POST')

    def do_PUT(self):
        self._dispatch('PUT')

    def do_PATCH(self):
        self._dispatch('PATCH')

    def do_DELETE(self):
        self._dispatch('DELETE')

    def _dispatch(self, method):
        self._status = None
        target = urlsplit(self.path)
        raw_path = target.path
        path = unquote(raw_path)
        self._query = target.query
        is_api = path == '/api' or path.startswith('/api/')
        try:
            if not self._host_allowed():
                raise ApiError(403, 'host not allowed')
            if method in ('POST', 'PUT', 'PATCH', 'DELETE') and not self._origin_allowed():
                raise ApiError(403, 'origin not allowed')
            if is_api:
                self._api(method, path)
            else:
                self._static(method, path)
        except ApiError as err:
            self._send_json(err.status, {'error': err.message}, err.headers)
        except Exception:
            traceback.print_exc(file=self.server.log_stream)
            if self._status is None:
                try:
                    self._send_json(500, {'error': 'internal server error'})
                except OSError:
                    pass
        finally:
            if is_api and self._status is not None:
                # repr: a path may carry control bytes, which must not reach a terminal raw
                self.server.log_stream.write('%s %s %d\n' % (method, repr(raw_path)[1:-1], self._status))
                self.server.log_stream.flush()

    # --- request guards -------------------------------------------------

    def _host_allowed(self):
        host = self.headers.get('Host')
        return host is not None and host.lower() in self.server.allowed_hosts

    def _origin_allowed(self):
        origin = self.headers.get('Origin')
        if origin is None:
            return True
        return origin.lower() in self.server.allowed_origins

    # --- static files ---------------------------------------------------

    def _static(self, method, path):
        if method != 'GET':
            raise ApiError(405, 'method not allowed', [('Allow', 'GET')])
        rel = path.lstrip('/') or 'index.html'
        full = self._resolve_static(rel)
        if full is None:
            raise ApiError(404, 'not found')
        try:
            with open(full, 'rb') as handle:
                data = handle.read()
        except OSError:
            raise ApiError(404, 'not found')
        ctype = CONTENT_TYPES.get(os.path.splitext(full)[1].lower(), 'application/octet-stream')
        self._start(200, ctype, len(data))
        self.wfile.write(data)

    def _resolve_static(self, rel):
        web = self.server.web_dir
        try:
            full = os.path.realpath(os.path.join(web, rel))
        except (ValueError, OSError):
            return None
        if os.path.commonpath([web, full]) != web:
            return None
        if not os.path.isfile(full):
            return None
        return full

    # --- API ------------------------------------------------------------

    def _api(self, method, path):
        store = self.server.store
        if path == '/api/captures':
            if method == 'GET':
                self._send_json(200, {'captures': store.list_captures()})
                return
            if method == 'POST':
                self._create_capture()
                return
            raise ApiError(405, 'method not allowed', [('Allow', 'GET, POST')])

        if path == '/api/codebook':
            self._codebook(method)
            return

        if path == '/api/identifications':
            self._identifications(method)
            return

        prefix = '/api/captures/'
        if not path.startswith(prefix):
            raise ApiError(404, 'not found')
        rest = path[len(prefix):]
        if rest.endswith('.wav'):
            cid = rest[:-len('.wav')]
            if not is_valid_id(cid):
                raise ApiError(404, 'not found')
            if method != 'GET':
                raise ApiError(405, 'method not allowed', [('Allow', 'GET')])
            self._send_wav(cid)
            return

        if not is_valid_id(rest):
            raise ApiError(404, 'not found')
        if method == 'PATCH':
            self._patch_capture(rest)
        elif method == 'DELETE':
            store.delete(rest)
            self._start(204)
        else:
            raise ApiError(405, 'method not allowed', [('Allow', 'PATCH, DELETE')])

    def _create_capture(self):
        length = self._declared_length(MAX_WAV_BYTES)
        body = self._read_body(length)
        raw_meta = parse_qs(self._query, keep_blank_values=True).get('meta')
        if not raw_meta:
            raise ApiError(400, 'missing meta query parameter')
        meta = parse_json_object(raw_meta[0], 'meta')
        if not body:
            raise ApiError(400, 'empty body')
        if len(body) < 12 or body[:4] != b'RIFF' or body[8:12] != b'WAVE':
            raise ApiError(400, 'body is not a WAV file (RIFF/WAVE header missing)')
        stored = self.server.store.create(body, meta)
        self._send_json(201, stored, [('Location', '/api/captures/' + stored['id'])])

    def _patch_capture(self, cid):
        length = self._declared_length(MAX_PATCH_BYTES)
        body = self._read_body(length)
        changes = parse_json_object(body, 'body')
        updated = self.server.store.patch(cid, changes)
        self._send_json(200, updated)

    def _send_wav(self, cid):
        path = self.server.store.wav_path(cid)
        try:
            handle = open(path, 'rb')
        except OSError:
            raise not_found()
        with handle:
            size = os.fstat(handle.fileno()).st_size
            self._start(200, 'audio/wav', size)
            shutil.copyfileobj(handle, self.wfile)

    def _codebook(self, method):
        store = self.server.codebook
        if method == 'GET':
            self._send_json(200, store.load())
        elif method == 'PUT':
            length = self._declared_length(MAX_CODEBOOK_BYTES)
            codebook = parse_json_object(self._read_body(length), 'body')
            check_codebook(codebook)
            self._send_json(200, store.save(codebook))
        else:
            raise ApiError(405, 'method not allowed', [('Allow', 'GET, PUT')])

    def _identifications(self, method):
        log = self.server.identifications
        if method == 'GET':
            self._send_json(200, {'identifications': log.entries()})
        elif method == 'POST':
            length = self._declared_length(MAX_IDENTIFICATION_BYTES)
            entry = parse_json_object(self._read_body(length), 'body')
            self._send_json(201, log.append(entry))
        else:
            raise ApiError(405, 'method not allowed', [('Allow', 'GET, POST')])

    def _declared_length(self, limit):
        raw = self.headers.get('Content-Length')
        if raw is None:
            raise ApiError(411, 'Content-Length header required')
        if not (raw.isascii() and raw.isdigit()):
            raise ApiError(400, 'invalid Content-Length')
        n = int(raw)
        if n > limit:
            raise ApiError(413, 'body too large; limit is %d bytes' % limit)
        return n

    def _read_body(self, length):
        data = self.rfile.read(length)
        if len(data) != length:
            raise ApiError(400, 'request body ended early')
        return data

    # --- response helpers -----------------------------------------------

    def _start(self, status, ctype=None, length=None, extra=()):
        self.send_response(status)
        if ctype is not None:
            self.send_header('Content-Type', ctype)
        if length is not None:
            self.send_header('Content-Length', str(length))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        if ctype is not None and ctype.startswith('text/html'):
            self.send_header('Content-Security-Policy', CONTENT_SECURITY_POLICY)
        for name, value in extra:
            self.send_header(name, value)
        self.end_headers()

    def _send_json(self, status, obj, extra=()):
        body = json.dumps(obj).encode('utf-8')
        self._start(status, 'application/json; charset=utf-8', len(body), extra)
        self.wfile.write(body)


def make_server(port, web_dir, recordings_dir, log_stream=None, codebook_path=None):
    """Bind 127.0.0.1:port (0 = ephemeral) and return the un-started server.

    codebook_path defaults to codebook.json, next to server.py, which starts out as a copy of
    codebook.example.json. The identification
    log is kept in the same directory as the codebook.
    """
    server = ThreadingHTTPServer((HOST, port), CaptureHandler)
    bound = server.server_address[1]
    hosts = ('%s:%d' % (HOST, bound), 'localhost:%d' % bound)
    server.allowed_hosts = frozenset(h.lower() for h in hosts)
    server.allowed_origins = frozenset('http://' + h for h in server.allowed_hosts)
    server.web_dir = os.path.realpath(web_dir)
    server.store = CaptureStore(os.path.abspath(recordings_dir))
    example = None
    if codebook_path is None:
        codebook_path, example = DEFAULT_CODEBOOK_PATH, EXAMPLE_CODEBOOK_PATH
    server.codebook = CodebookStore(os.path.abspath(codebook_path), example)
    server.identifications = IdentificationLog(
        os.path.join(os.path.dirname(os.path.abspath(codebook_path)), IDENTIFICATIONS_FILE))
    server.log_stream = log_stream if log_stream is not None else sys.stderr
    return server


def main(argv=None):
    parser = argparse.ArgumentParser(description='OSSTagLab: local server for the club tag web app.')
    parser.add_argument('--port', type=int, default=DEFAULT_PORT)
    parser.add_argument('--recordings', metavar='DIR', default=None)
    parser.add_argument('--web', metavar='DIR', default=None)
    args = parser.parse_args(argv)
    if not 0 <= args.port <= 65535:
        parser.error('--port must be between 0 and 65535')

    here = os.path.dirname(os.path.abspath(__file__))
    web_dir = args.web or os.path.join(here, 'web')
    recordings_dir = args.recordings or os.path.join(here, 'recordings')

    try:
        server = make_server(args.port, web_dir, recordings_dir)
    except OSError as err:
        if err.errno == errno.EADDRINUSE:
            print('error: port %d is already in use on %s; pick another with --port'
                  % (args.port, HOST), file=sys.stderr)
        else:
            print('error: cannot listen on %s:%d: %s' % (HOST, args.port, err), file=sys.stderr)
        return 1

    print('OSSTagLab running at http://%s:%d/  (Ctrl-C to stop)'
          % (HOST, server.server_address[1]), flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nStopped.', flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
