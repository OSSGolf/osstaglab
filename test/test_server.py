"""Tests for server.py.

Run from the repository root:
    python3 -m unittest discover -s test -p 'test_*.py' -v
"""

import contextlib
import datetime
import errno
import http.client
import io
import json
import os
import re
import shutil
import socket
import sys
import tempfile
import threading
import unittest
from unittest import mock
from urllib.parse import quote

REPO_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, REPO_DIR)
import server as app_server  # noqa: E402

ID_PATTERN = re.compile(r'^[0-9]{8}-[0-9]{6}-[0-9]{3}(-[0-9]+)?$')
FIXED_NOW = datetime.datetime(2026, 1, 2, 3, 4, 5, 678000).astimezone()
FIXED_BASE = '20260102-030405-678'


def make_wav(payload=b'\x01\x02\x03\x04' * 8):
    return b'RIFF' + (4 + len(payload)).to_bytes(4, 'little') + b'WAVE' + payload


class ServerTestCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix='osstaglab-test-')
        self.web = os.path.join(self.tmp, 'web')
        self.rec = os.path.join(self.tmp, 'recordings')
        self.codebook = os.path.join(self.tmp, 'codebook.json')
        os.makedirs(os.path.join(self.web, 'sub'))
        files = {
            'index.html': b'<!doctype html><title>home</title>',
            'app.js': b'console.log(1);',
            'mod.mjs': b'export const x = 1;',
            'style.css': b'body{}',
            'data.json': b'{"a":1}',
            'pic.svg': b'<svg xmlns="http://www.w3.org/2000/svg"/>',
            'icon.png': b'\x89PNG\r\n\x1a\n',
            'clip.wav': make_wav(),
            os.path.join('sub', 'page.html'): b'<p>sub</p>',
        }
        for rel, data in files.items():
            with open(os.path.join(self.web, rel), 'wb') as handle:
                handle.write(data)
        # Material outside the web root that traversal attempts must not reach.
        with open(os.path.join(self.tmp, 'secret.txt'), 'w') as handle:
            handle.write('TOP-SECRET')
        os.makedirs(os.path.join(self.tmp, 'web-evil'))
        with open(os.path.join(self.tmp, 'web-evil', 'x.txt'), 'w') as handle:
            handle.write('SIBLING-SECRET')
        os.symlink(os.path.join(self.tmp, 'secret.txt'), os.path.join(self.web, 'link.txt'))

        self.log = io.StringIO()
        self.server = app_server.make_server(0, self.web, self.rec, log_stream=self.log,
                                      codebook_path=self.codebook)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever,
                                       kwargs={'poll_interval': 0.01}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(5)
        shutil.rmtree(self.tmp, ignore_errors=True)

    # --- helpers --------------------------------------------------------

    def http(self, method, path, body=None, headers=None):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=10)
        try:
            conn.request(method, path, body=body, headers=headers or {})
            resp = conn.getresponse()
            data = resp.read()
            hdrs = {k.lower(): v for k, v in resp.getheaders()}
            return resp.status, hdrs, data
        finally:
            conn.close()

    def http_json(self, method, path, body=None, headers=None):
        status, hdrs, data = self.http(method, path, body, headers)
        return status, json.loads(data.decode('utf-8')) if data else None

    def post_wav(self, meta, wav=None, headers=None):
        hdrs = {'Content-Type': 'audio/wav'}
        hdrs.update(headers or {})
        path = '/api/captures?meta=' + quote(json.dumps(meta))
        return self.http_json('POST', path, body=wav if wav is not None else make_wav(), headers=hdrs)

    def raw(self, request_bytes):
        sock = socket.create_connection(('127.0.0.1', self.port), timeout=10)
        try:
            sock.sendall(request_bytes)
            chunks = []
            while True:
                chunk = sock.recv(65536)
                if not chunk:
                    break
                chunks.append(chunk)
        finally:
            sock.close()
        head, _, body = b''.join(chunks).partition(b'\r\n\r\n')
        status = int(head.split(b'\r\n', 1)[0].split(b' ')[1])
        return status, head, body

    def raw_head(self, method, path, *extra_headers):
        lines = ['%s %s HTTP/1.0' % (method, path), 'Host: 127.0.0.1:%d' % self.port]
        lines.extend(extra_headers)
        return ('\r\n'.join(lines) + '\r\n\r\n').encode('latin-1')

    def log_lines(self):
        return [line for line in self.log.getvalue().splitlines() if line]


class StaticTests(ServerTestCase):
    def test_root_serves_index_with_no_store(self):
        status, hdrs, data = self.http('GET', '/')
        self.assertEqual(status, 200)
        self.assertEqual(hdrs['content-type'], 'text/html; charset=utf-8')
        self.assertEqual(hdrs['cache-control'], 'no-store')
        self.assertEqual(data, b'<!doctype html><title>home</title>')

    def test_mime_types(self):
        cases = {
            '/app.js': 'text/javascript; charset=utf-8',
            '/mod.mjs': 'text/javascript; charset=utf-8',
            '/style.css': 'text/css; charset=utf-8',
            '/data.json': 'application/json; charset=utf-8',
            '/clip.wav': 'audio/wav',
            '/pic.svg': 'image/svg+xml; charset=utf-8',
            '/icon.png': 'image/png',
            '/sub/page.html': 'text/html; charset=utf-8',
        }
        for path, expected in cases.items():
            with self.subTest(path=path):
                status, hdrs, _ = self.http('GET', path)
                self.assertEqual(status, 200)
                self.assertEqual(hdrs['content-type'], expected)
                self.assertEqual(hdrs['cache-control'], 'no-store')

    def test_missing_static_file_is_404(self):
        status, _, _ = self.http('GET', '/nope.html')
        self.assertEqual(status, 404)

    def test_traversal_is_refused(self):
        attempts = [
            '/../secret.txt',                # raw dot-dot
            '/%2e%2e/secret.txt',            # encoded dots
            '/%2E%2E/secret.txt',
            '/%2e%2e%2fsecret.txt',          # encoded dots and slash
            '/..%2fsecret.txt',
            '/sub/../../secret.txt',
            '/../web-evil/x.txt',            # sibling dir sharing the prefix
            '/link.txt',                     # symlink pointing outside the root
            '//' + os.path.join(self.tmp, 'secret.txt').lstrip('/'),
            '/%00index.html',
        ]
        for path in attempts:
            with self.subTest(path=path):
                status, _, data = self.http('GET', path)
                self.assertEqual(status, 404)
                self.assertNotIn(b'SECRET', data)

    def test_static_requests_are_not_logged(self):
        self.http('GET', '/')
        self.http('GET', '/app.js')
        self.http('GET', '/missing.html')
        self.assertEqual(self.log_lines(), [])

    def test_non_get_on_static_is_405(self):
        status, hdrs, _ = self.http('POST', '/index.html', body=b'x', headers={'Content-Length': '1'})
        self.assertEqual(status, 405)
        self.assertEqual(hdrs['allow'], 'GET')


class CaptureLifecycleTests(ServerTestCase):
    def test_full_lifecycle(self):
        wav = make_wav(b'\xaa\xbb' * 100)
        status, stored = self.post_wav({'label': 'first', 'tag': 'driver'}, wav=wav)
        self.assertEqual(status, 201)
        cid = stored['id']
        self.assertRegex(cid, ID_PATTERN)
        self.assertEqual(stored['file'], cid + '.wav')
        self.assertEqual(stored['bytes'], len(wav))
        self.assertEqual(stored['label'], 'first')
        self.assertIsNotNone(datetime.datetime.fromisoformat(stored['savedAt']).utcoffset())
        self.assertTrue(os.path.isfile(os.path.join(self.rec, cid + '.wav')))
        self.assertTrue(os.path.isfile(os.path.join(self.rec, cid + '.json')))

        status, listing = self.http_json('GET', '/api/captures')
        self.assertEqual(status, 200)
        self.assertEqual([c['id'] for c in listing['captures']], [cid])

        status, hdrs, data = self.http('GET', '/api/captures/%s.wav' % cid)
        self.assertEqual(status, 200)
        self.assertEqual(hdrs['content-type'], 'audio/wav')
        self.assertEqual(data, wav)

        status, updated = self.http_json(
            'PATCH', '/api/captures/' + cid, body=json.dumps({'label': 'renamed', 'note': 'n'}).encode())
        self.assertEqual(status, 200)
        self.assertEqual(updated['label'], 'renamed')
        self.assertEqual(updated['note'], 'n')
        self.assertEqual(updated['tag'], 'driver')

        status, listing = self.http_json('GET', '/api/captures')
        self.assertEqual(listing['captures'][0]['label'], 'renamed')

        status, hdrs, data = self.http('DELETE', '/api/captures/' + cid)
        self.assertEqual(status, 204)
        self.assertEqual(data, b'')
        self.assertNotIn('content-length', hdrs)
        self.assertFalse(os.path.exists(os.path.join(self.rec, cid + '.wav')))
        self.assertFalse(os.path.exists(os.path.join(self.rec, cid + '.json')))

        status, _, _ = self.http('GET', '/api/captures/%s.wav' % cid)
        self.assertEqual(status, 404)
        status, listing = self.http_json('GET', '/api/captures')
        self.assertEqual(listing['captures'], [])

    def test_recordings_dir_created_on_demand(self):
        self.assertFalse(os.path.isdir(self.rec))
        status, listing = self.http_json('GET', '/api/captures')
        self.assertEqual((status, listing), (200, {'captures': []}))
        self.assertFalse(os.path.isdir(self.rec))
        status, _ = self.post_wav({})
        self.assertEqual(status, 201)
        self.assertTrue(os.path.isdir(self.rec))

    def test_list_is_newest_first(self):
        _, first = self.post_wav({'n': 1})
        _, second = self.post_wav({'n': 2})
        status, listing = self.http_json('GET', '/api/captures')
        self.assertEqual([c['id'] for c in listing['captures']], [second['id'], first['id']])

    def test_id_collision_gets_suffix(self):
        with mock.patch.object(app_server, 'now_local', return_value=FIXED_NOW):
            ids = [self.post_wav({})[1]['id'] for _ in range(3)]
        self.assertEqual(ids, [FIXED_BASE, FIXED_BASE + '-2', FIXED_BASE + '-3'])
        _, listing = self.http_json('GET', '/api/captures')
        self.assertEqual([c['id'] for c in listing['captures']], list(reversed(ids)))

    def test_corrupt_and_orphan_sidecars_are_skipped(self):
        os.makedirs(self.rec)
        good = '20260101-000000-001'
        with open(os.path.join(self.rec, good + '.wav'), 'wb') as handle:
            handle.write(make_wav())
        with open(os.path.join(self.rec, good + '.json'), 'w') as handle:
            json.dump({'id': good, 'file': good + '.wav'}, handle)
        bad = {
            '20260101-000000-002': 'x{ not json',       # corrupt, wav present
            '20260101-000000-003': '{"id": "orphan"}',  # valid json, no wav
            '20260101-000000-004': '[1, 2]',            # not an object
        }
        for cid, text in bad.items():
            with open(os.path.join(self.rec, cid + '.json'), 'w') as handle:
                handle.write(text)
            if cid == '20260101-000000-002':
                with open(os.path.join(self.rec, cid + '.wav'), 'wb') as handle:
                    handle.write(make_wav())
        with open(os.path.join(self.rec, 'notes.json'), 'w') as handle:
            handle.write('{}')
        status, listing = self.http_json('GET', '/api/captures')
        self.assertEqual(status, 200)
        self.assertEqual([c['id'] for c in listing['captures']], [good])

    def test_server_owned_keys_cannot_be_set_by_client_meta(self):
        wav = make_wav(b'\x00' * 40)
        status, stored = self.post_wav(
            {'id': 'hacked', 'file': 'evil.wav', 'savedAt': 'yesterday', 'bytes': 1, 'label': 'ok'}, wav=wav)
        self.assertEqual(status, 201)
        self.assertRegex(stored['id'], ID_PATTERN)
        self.assertEqual(stored['file'], stored['id'] + '.wav')
        self.assertEqual(stored['bytes'], len(wav))
        self.assertNotEqual(stored['savedAt'], 'yesterday')
        self.assertEqual(stored['label'], 'ok')
        with open(os.path.join(self.rec, stored['id'] + '.json')) as handle:
            on_disk = json.load(handle)
        self.assertEqual(on_disk['id'], stored['id'])
        self.assertEqual(on_disk['file'], stored['id'] + '.wav')

    def test_server_owned_keys_cannot_be_changed_by_patch(self):
        _, stored = self.post_wav({'label': 'a'})
        cid = stored['id']
        status, updated = self.http_json('PATCH', '/api/captures/' + cid, body=json.dumps({
            'id': 'zz', 'file': 'other.wav', 'savedAt': '2000-01-01T00:00:00+00:00',
            'bytes': 0, 'label': 'changed'}).encode())
        self.assertEqual(status, 200)
        self.assertEqual(updated['id'], cid)
        self.assertEqual(updated['file'], cid + '.wav')
        self.assertEqual(updated['savedAt'], stored['savedAt'])
        self.assertEqual(updated['bytes'], stored['bytes'])
        self.assertEqual(updated['label'], 'changed')
        status, hdrs, data = self.http('GET', '/api/captures/%s.wav' % cid)
        self.assertEqual(status, 200)
        self.assertEqual(data, make_wav())  # wav still intact and still served under the same id


class RejectionTests(ServerTestCase):
    def test_post_without_content_length_is_411(self):
        status, _, _ = self.raw(self.raw_head('POST', '/api/captures?meta=%7B%7D'))
        self.assertEqual(status, 411)

    def test_post_invalid_content_length_is_400(self):
        status, _, _ = self.raw(self.raw_head('POST', '/api/captures?meta=%7B%7D', 'Content-Length: abc'))
        self.assertEqual(status, 400)

    def test_post_over_64mb_is_413_and_stores_nothing(self):
        too_big = 64 * 1024 * 1024 + 1
        status, _, body = self.raw(
            b'POST /api/captures?meta=%7B%7D HTTP/1.0\r\nHost: 127.0.0.1:' + str(self.port).encode()
            + b'\r\nContent-Length: ' + str(too_big).encode() + b'\r\n\r\n')
        self.assertEqual(status, 413)
        self.assertIn(b'error', body)
        self.assertFalse(os.path.isdir(self.rec))

    def test_post_empty_body_is_400(self):
        status, body = self.post_wav({}, wav=b'')
        self.assertEqual(status, 400)
        self.assertIn('error', body)

    def test_post_non_wav_body_is_400(self):
        for wav in (b'hello world, not audio', b'RIFF0000AVI ', b'RIFF', b'WAVE' * 4):
            with self.subTest(body=wav[:12]):
                status, body = self.post_wav({}, wav=wav)
                self.assertEqual(status, 400)
                self.assertIn('error', body)

    def test_post_meta_validation(self):
        cases = {
            'missing': '/api/captures',
            'blank': '/api/captures?meta=',
            'not json': '/api/captures?meta=' + quote('{nope'),
            'array': '/api/captures?meta=' + quote('[1,2]'),
            'string': '/api/captures?meta=' + quote('"text"'),
            'number': '/api/captures?meta=1',
            'null': '/api/captures?meta=null',
            'nan': '/api/captures?meta=' + quote('{"a": NaN}'),
        }
        for name, path in cases.items():
            with self.subTest(meta=name):
                status, body = self.http_json('POST', path, body=make_wav(),
                                              headers={'Content-Type': 'audio/wav'})
                self.assertEqual(status, 400)
                self.assertIn('error', body)
        self.assertFalse(os.path.isdir(self.rec) and os.listdir(self.rec))

    def test_patch_rejections(self):
        _, stored = self.post_wav({})
        path = '/api/captures/' + stored['id']
        status, body = self.http_json('PATCH', path, body=b'')
        self.assertEqual(status, 400)
        status, body = self.http_json('PATCH', path, body=b'[1, 2, 3]')
        self.assertEqual(status, 400)
        self.assertIn('error', body)
        status, body = self.http_json('PATCH', path, body=b'{broken')
        self.assertEqual(status, 400)
        status, body = self.http_json('PATCH', path, body=b'{"a": Infinity}')
        self.assertEqual(status, 400)
        status, _, _ = self.raw(('PATCH %s HTTP/1.0\r\nHost: 127.0.0.1:%d\r\n'
                                 'Content-Length: %d\r\n\r\n'
                                 % (path, self.port, 1024 * 1024 + 1)).encode())
        self.assertEqual(status, 413)
        status, _, _ = self.raw(('PATCH %s HTTP/1.0\r\nHost: 127.0.0.1:%d\r\n\r\n'
                                 % (path, self.port)).encode())
        self.assertEqual(status, 411)

    def test_unknown_id_is_404_for_every_method(self):
        missing = '20000101-000000-000'
        self.assertEqual(self.http('GET', '/api/captures/%s.wav' % missing)[0], 404)
        self.assertEqual(self.http('PATCH', '/api/captures/' + missing, body=b'{}')[0], 404)
        self.assertEqual(self.http('DELETE', '/api/captures/' + missing)[0], 404)

    def test_malformed_ids_are_404(self):
        paths = [
            '/api/captures/notanid.wav',
            '/api/captures/20260101-000000-1.wav.wav',
            '/api/captures/20260101-000000-000-x.wav',
            '/api/captures/20260101-000000-000-',
            '/api/captures/20260101-000000-1',
            '/api/captures/..%2F..%2Fsecret',
            '/api/captures/%2e%2e',
            '/api/captures/20260101-000000-000%0A',
        ]
        for path in paths:
            with self.subTest(path=path):
                self.assertEqual(self.http('GET', path)[0], 404)
                self.assertEqual(self.http('DELETE', path)[0], 404)

    def test_unknown_api_routes_are_404(self):
        for path in ('/api/nothing', '/api', '/api/', '/api/captures/', '/api/captures/a/b'):
            with self.subTest(path=path):
                self.assertEqual(self.http('GET', path)[0], 404)

    def test_wrong_method_on_known_route_is_405(self):
        _, stored = self.post_wav({})
        cid = stored['id']
        cases = [
            ('PUT', '/api/captures', 'GET, POST'),
            ('DELETE', '/api/captures', 'GET, POST'),
            ('PATCH', '/api/captures', 'GET, POST'),
            ('POST', '/api/captures/%s.wav' % cid, 'GET'),
            ('GET', '/api/captures/' + cid, 'PATCH, DELETE'),
            ('PUT', '/api/captures/' + cid, 'PATCH, DELETE'),
            ('GET', '/api/captures/20000101-000000-000', 'PATCH, DELETE'),
        ]
        for method, path, allow in cases:
            with self.subTest(method=method, path=path):
                status, hdrs, _ = self.http(method, path, body=b'' if method != 'GET' else None,
                                            headers={'Content-Length': '0'} if method != 'GET' else None)
                self.assertEqual(status, 405)
                self.assertEqual(hdrs['allow'], allow)


class HostOriginTests(ServerTestCase):
    def test_foreign_host_is_403(self):
        bad_hosts = ['evil.example:%d' % self.port, '127.0.0.1', 'localhost:%d' % (self.port + 1),
                     '127.0.0.1:%d.evil.example' % self.port]
        for host in bad_hosts:
            with self.subTest(host=host):
                self.assertEqual(self.http('GET', '/', headers={'Host': host})[0], 403)
                self.assertEqual(self.http('GET', '/api/captures', headers={'Host': host})[0], 403)

    def test_missing_host_is_403(self):
        status, _, _ = self.raw(b'GET /api/captures HTTP/1.0\r\n\r\n')
        self.assertEqual(status, 403)

    def test_loopback_hosts_are_allowed(self):
        for host in ('127.0.0.1:%d' % self.port, 'localhost:%d' % self.port, 'LOCALHOST:%d' % self.port):
            with self.subTest(host=host):
                self.assertEqual(self.http('GET', '/api/captures', headers={'Host': host})[0], 200)

    def test_bad_origin_rejected_on_writes(self):
        _, stored = self.post_wav({})
        cid = stored['id']
        bad_origins = ['http://evil.example', 'null', 'https://localhost:%d' % self.port,
                       'http://localhost:%d.evil' % self.port, '']
        for origin in bad_origins:
            hdr = {'Origin': origin}
            with self.subTest(origin=origin):
                self.assertEqual(self.post_wav({}, headers=hdr)[0], 403)
                self.assertEqual(self.http('PATCH', '/api/captures/' + cid, body=b'{}',
                                           headers=dict(hdr, **{'Content-Length': '2'}))[0], 403)
                self.assertEqual(self.http('DELETE', '/api/captures/' + cid, headers=hdr)[0], 403)
        self.assertEqual(self.http('GET', '/api/captures/%s.wav' % cid)[0], 200)

    def test_good_origin_allowed_on_writes(self):
        for origin in ('http://localhost:%d' % self.port, 'http://127.0.0.1:%d' % self.port):
            with self.subTest(origin=origin):
                status, stored = self.post_wav({}, headers={'Origin': origin})
                self.assertEqual(status, 201)
                status, _ = self.http_json('PATCH', '/api/captures/' + stored['id'],
                                           body=b'{"a": 1}', headers={'Origin': origin})
                self.assertEqual(status, 200)
                status, _, _ = self.http('DELETE', '/api/captures/' + stored['id'],
                                         headers={'Origin': origin})
                self.assertEqual(status, 204)

    def test_origin_not_checked_on_reads(self):
        self.assertEqual(self.http('GET', '/api/captures', headers={'Origin': 'http://evil.example'})[0], 200)
        self.assertEqual(self.http('GET', '/', headers={'Origin': 'null'})[0], 200)


class LoggingTests(ServerTestCase):
    def test_one_line_per_api_call(self):
        _, stored = self.post_wav({})
        cid = stored['id']
        self.http('GET', '/api/captures')
        self.http('GET', '/api/captures/%s.wav' % cid)
        self.http('PATCH', '/api/captures/' + cid, body=b'{"x": 1}')
        self.http('DELETE', '/api/captures/' + cid)
        self.assertEqual(self.log_lines(), [
            'POST /api/captures 201',
            'GET /api/captures 200',
            'GET /api/captures/%s.wav 200' % cid,
            'PATCH /api/captures/%s 200' % cid,
            'DELETE /api/captures/%s 204' % cid,
        ])


class CodebookTests(ServerTestCase):
    def test_get_when_missing_returns_empty_document(self):
        status, hdrs, data = self.http('GET', '/api/codebook')
        self.assertEqual(status, 200)
        self.assertEqual(hdrs['cache-control'], 'no-store')
        self.assertEqual(json.loads(data.decode('utf-8')), {'version': 1, 'clubs': {}})
        self.assertFalse(os.path.exists(self.codebook))

    def test_example_codebook_is_served_until_the_first_save(self):
        example = os.path.join(self.tmp, 'codebook.example.json')
        doc = {'version': 1, 'revision': 0, 'clubs': {'putter': {'observations': [{'kind': 'tone', 'hz': 19808}]}}}
        with open(example, 'w') as handle:
            json.dump(doc, handle)
        self.server.codebook.example = example
        status, body = self.http_json('GET', '/api/codebook')
        self.assertEqual((status, body), (200, doc))
        self.assertFalse(os.path.exists(self.codebook))
        edited = dict(doc, clubs={})
        status, stored = self.http_json('PUT', '/api/codebook', body=json.dumps(edited).encode())
        self.assertEqual((status, stored), (200, dict(edited, revision=1)))
        with open(example) as handle:
            self.assertEqual(json.load(handle), doc)            # the example is never written
        status, body = self.http_json('GET', '/api/codebook')
        self.assertEqual(body, dict(edited, revision=1))        # the saved file now wins

    def test_every_response_forbids_sniffing_and_cross_origin_embedding(self):
        for path in ('/', '/api/codebook', '/nope'):
            with self.subTest(path=path):
                _, hdrs, _ = self.http('GET', path)
                self.assertEqual(hdrs['x-content-type-options'], 'nosniff')
                self.assertEqual(hdrs['cross-origin-resource-policy'], 'same-origin')
        _, hdrs, _ = self.http('GET', '/')
        self.assertIn("default-src 'self'", hdrs['content-security-policy'])
        self.assertIn("frame-ancestors 'none'", hdrs['content-security-policy'])

    def test_put_then_get_round_trips(self):
        doc = {'version': 1, 'clubs': {'iron7': {'observations': [{'kind': 'tone', 'hz': 18800}]}}}
        status, stored = self.http_json('PUT', '/api/codebook', body=json.dumps(doc).encode())
        self.assertEqual(status, 200)
        doc = dict(doc, revision=1)
        self.assertEqual(stored, doc)
        status, hdrs, data = self.http('GET', '/api/codebook')
        self.assertEqual(status, 200)
        self.assertEqual(hdrs['content-type'], 'application/json; charset=utf-8')
        self.assertEqual(hdrs['cache-control'], 'no-store')
        self.assertEqual(json.loads(data.decode('utf-8')), doc)

    def test_file_is_pretty_printed_with_trailing_newline(self):
        doc = {'clubs': {'wedge': {'loft': 56}, '5i': {'loft': 24}}, 'version': 1}
        status, _ = self.http_json('PUT', '/api/codebook', body=json.dumps(doc).encode())
        self.assertEqual(status, 200)
        with open(self.codebook, 'rb') as handle:
            on_disk = handle.read()
        stored = dict(doc, revision=1)
        self.assertEqual(on_disk, (json.dumps(stored, indent=2, sort_keys=True) + '\n').encode('utf-8'))

    def test_put_rejects_invalid_documents(self):
        cases = {
            'empty body': b'',
            'not json': b'{broken',
            'nan': b'{"version": 1, "clubs": {}, "x": NaN}',
            'array': b'[1, 2]',
            'string': b'"text"',
            'null': b'null',
            'version missing': b'{"clubs": {}}',
            'version 2': b'{"version": 2, "clubs": {}}',
            'version string': b'{"version": "1", "clubs": {}}',
            'version float': b'{"version": 1.0, "clubs": {}}',
            'version true': b'{"version": true, "clubs": {}}',
            'clubs missing': b'{"version": 1}',
            'clubs array': b'{"version": 1, "clubs": []}',
            'clubs null': b'{"version": 1, "clubs": null}',
            'revision negative': b'{"version": 1, "clubs": {}, "revision": -1}',
            'revision float': b'{"version": 1, "clubs": {}, "revision": 1.5}',
            'revision string': b'{"version": 1, "clubs": {}, "revision": "1"}',
            'revision true': b'{"version": 1, "clubs": {}, "revision": true}',
        }
        for name, body in cases.items():
            with self.subTest(case=name):
                status, resp = self.http_json('PUT', '/api/codebook', body=body)
                self.assertEqual(status, 400)
                self.assertIn('error', resp)
        self.assertFalse(os.path.exists(self.codebook))

    def put_codebook(self, doc):
        return self.http_json('PUT', '/api/codebook', body=json.dumps(doc).encode())

    def test_each_save_must_build_on_the_stored_revision(self):
        status, first = self.put_codebook({'version': 1, 'clubs': {'a': {'observations': []}}})
        self.assertEqual((status, first['revision']), (200, 1))
        status, second = self.put_codebook(dict(first, clubs={'b': {'observations': []}}))
        self.assertEqual((status, second['revision']), (200, 2))
        self.assertEqual(self.http_json('GET', '/api/codebook')[1], second)

    def test_stale_save_is_409_and_changes_nothing(self):
        _, first = self.put_codebook({'version': 1, 'clubs': {'a': {'observations': []}}})
        _, second = self.put_codebook(dict(first, clubs={'a': {'observations': []}, 'b': {'observations': []}}))
        with open(self.codebook, 'rb') as handle:
            before = handle.read()
        # A window still holding the first revision (or none at all) must not undo the second save.
        for stale in (dict(first, clubs={}), {'version': 1, 'clubs': {}}, dict(second, revision=99, clubs={})):
            with self.subTest(revision=stale.get('revision')):
                status, body = self.put_codebook(stale)
                self.assertEqual(status, 409)
                self.assertIn('another window', body['error'])
                with open(self.codebook, 'rb') as handle:
                    self.assertEqual(handle.read(), before)

    def test_file_without_revision_is_revision_0(self):
        with open(self.codebook, 'wb') as handle:
            handle.write(b'{"version": 1, "clubs": {"a": {"observations": []}}}')
        status, stored = self.put_codebook({'version': 1, 'revision': 0, 'clubs': {}})
        self.assertEqual((status, stored['revision']), (200, 1))

    def test_file_with_invalid_revision_is_500_and_left_untouched(self):
        text = b'{"version": 1, "clubs": {}, "revision": "x"}'
        with open(self.codebook, 'wb') as handle:
            handle.write(text)
        status, body = self.put_codebook({'version': 1, 'clubs': {}})
        self.assertEqual(status, 500)
        self.assertIn('invalid revision', body['error'])
        with open(self.codebook, 'rb') as handle:
            self.assertEqual(handle.read(), text)

    def test_put_over_1mb_is_413_and_stores_nothing(self):
        status, _, body = self.raw(('PUT /api/codebook HTTP/1.0\r\nHost: 127.0.0.1:%d\r\n'
                                    'Content-Length: %d\r\n\r\n'
                                    % (self.port, app_server.MAX_CODEBOOK_BYTES + 1)).encode())
        self.assertEqual(status, 413)
        self.assertIn(b'error', body)
        self.assertFalse(os.path.exists(self.codebook))

    def test_put_without_content_length_is_411(self):
        status, _, _ = self.raw(self.raw_head('PUT', '/api/codebook'))
        self.assertEqual(status, 411)

    def test_other_methods_on_codebook_are_405(self):
        for method in ('POST', 'PATCH', 'DELETE'):
            with self.subTest(method=method):
                status, hdrs, _ = self.http(method, '/api/codebook', body=b'', headers={'Content-Length': '0'})
                self.assertEqual(status, 405)
                self.assertEqual(hdrs['allow'], 'GET, PUT')

    def test_corrupt_file_is_500_and_left_untouched(self):
        for text in (b'{"version": 1, "clubs": ', b'[1, 2]'):
            with self.subTest(text=text):
                with open(self.codebook, 'wb') as handle:
                    handle.write(text)
                status, body = self.http_json('GET', '/api/codebook')
                self.assertEqual(status, 500)
                # the browser is told which file by name, never by its full path
                self.assertIn('codebook.json', body['error'])
                self.assertNotIn(self.tmp, body['error'])
                status, body = self.http_json('PUT', '/api/codebook', body=b'{"version": 1, "clubs": {}}')
                self.assertEqual(status, 500)
                with open(self.codebook, 'rb') as handle:
                    self.assertEqual(handle.read(), text)

    def test_bad_origin_and_host_are_refused_on_put(self):
        doc = b'{"version": 1, "clubs": {}}'
        for origin in ('http://evil.example', 'null', 'https://localhost:%d' % self.port, ''):
            with self.subTest(origin=origin):
                status, _ = self.http_json('PUT', '/api/codebook', body=doc, headers={'Origin': origin})
                self.assertEqual(status, 403)
        self.assertFalse(os.path.exists(self.codebook))
        self.assertEqual(self.http('GET', '/api/codebook', headers={'Host': 'evil.example:%d' % self.port})[0], 403)
        status, _ = self.http_json('PUT', '/api/codebook', body=doc,
                                   headers={'Origin': 'http://localhost:%d' % self.port})
        self.assertEqual(status, 200)

    def test_successful_put_leaves_no_temp_file(self):
        before = set(os.listdir(self.tmp))
        status, _ = self.http_json('PUT', '/api/codebook', body=b'{"version": 1, "clubs": {}}')
        self.assertEqual(status, 200)
        self.assertEqual(set(os.listdir(self.tmp)) - before, {'codebook.json'})

    def test_failed_write_is_500_keeps_old_file_and_removes_temp(self):
        original = b'{\n  "clubs": {},\n  "version": 1\n}\n'
        with open(self.codebook, 'wb') as handle:
            handle.write(original)
        before = set(os.listdir(self.tmp))
        failure = OSError(errno.ENOSPC, 'No space left on device')
        with mock.patch.object(app_server.os, 'replace', side_effect=failure):
            status, body = self.http_json('PUT', '/api/codebook', body=b'{"version": 1, "clubs": {"a": {}}}')
        self.assertEqual(status, 500)
        self.assertIn('could not write', body['error'])
        self.assertEqual(set(os.listdir(self.tmp)), before)
        with open(self.codebook, 'rb') as handle:
            self.assertEqual(handle.read(), original)


class IdentificationLogTests(ServerTestCase):
    def log_path(self):
        return os.path.join(self.tmp, 'identifications.jsonl')

    def test_empty_until_something_is_logged(self):
        status, body = self.http_json('GET', '/api/identifications')
        self.assertEqual(status, 200)
        self.assertEqual(body, {'identifications': []})
        self.assertFalse(os.path.exists(self.log_path()))

    def test_entries_are_appended_in_order_and_stamped(self):
        first = {'expected': 'iron7', 'heard': ['iron7'], 'result': 'right'}
        second = {'expected': 'iron9', 'heard': [], 'result': 'not-read'}
        for entry in (first, second):
            status, stored = self.http_json('POST', '/api/identifications', body=json.dumps(entry).encode())
            self.assertEqual(status, 201)
            self.assertEqual({k: v for k, v in stored.items() if k != 'loggedAt'}, entry)
            self.assertRegex(stored['loggedAt'], r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$')
        status, body = self.http_json('GET', '/api/identifications')
        self.assertEqual([e['expected'] for e in body['identifications']], ['iron7', 'iron9'])
        with open(self.log_path(), 'rb') as handle:
            lines = handle.read().splitlines()
        self.assertEqual(len(lines), 2)
        self.assertEqual(json.loads(lines[1])['result'], 'not-read')

    def test_rejects_bodies_that_are_not_json_objects_or_are_too_large(self):
        for body in (b'', b'{broken', b'[1]', b'"text"', b'{"x": NaN}'):
            status, err = self.http_json('POST', '/api/identifications', body=body)
            self.assertEqual(status, 400, body)
            self.assertIn('error', err)
        big = json.dumps({'pad': 'x' * app_server.MAX_IDENTIFICATION_BYTES}).encode()
        status, _ = self.http_json('POST', '/api/identifications', body=big)
        self.assertEqual(status, 413)
        self.assertFalse(os.path.exists(self.log_path()))

    def test_other_methods_are_refused(self):
        status, hdrs, _ = self.http('DELETE', '/api/identifications')
        self.assertEqual(status, 405)
        self.assertEqual(hdrs['allow'], 'GET, POST')

    def test_post_from_another_origin_is_refused(self):
        status, _ = self.http_json('POST', '/api/identifications', body=b'{}',
                                   headers={'Origin': 'http://evil.example'})
        self.assertEqual(status, 403)
        self.assertFalse(os.path.exists(self.log_path()))


class MakeServerAndMainTests(ServerTestCase):
    def test_ephemeral_port_is_assigned(self):
        self.assertGreater(self.port, 0)
        self.assertEqual(self.server.server_address[0], '127.0.0.1')

    def test_codebook_defaults_to_file_next_to_server(self):
        server = app_server.make_server(0, self.web, self.rec, log_stream=io.StringIO())
        self.addCleanup(server.server_close)
        self.assertEqual(server.codebook.path, os.path.join(REPO_DIR, 'codebook.json'))

    def test_port_in_use_exits_1_with_message(self):
        blocker = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(blocker.close)
        blocker.bind(('127.0.0.1', 0))
        blocker.listen(1)
        port = blocker.getsockname()[1]
        err = io.StringIO()
        out = io.StringIO()
        with contextlib.redirect_stderr(err), contextlib.redirect_stdout(out):
            code = app_server.main(['--port', str(port), '--web', self.web, '--recordings', self.rec])
        self.assertEqual(code, 1)
        self.assertIn('already in use', err.getvalue())
        self.assertEqual(out.getvalue(), '')

    def test_main_prints_url_and_exits_cleanly_on_ctrl_c(self):
        out = io.StringIO()
        with mock.patch.object(app_server.ThreadingHTTPServer, 'serve_forever', side_effect=KeyboardInterrupt):
            with contextlib.redirect_stdout(out):
                code = app_server.main(['--port', '0', '--web', self.web, '--recordings', self.rec])
        self.assertEqual(code, 0)
        self.assertRegex(out.getvalue(), r'OSSTagLab running at http://127\.0\.0\.1:[0-9]+/')

    def test_bad_port_argument_is_rejected(self):
        with contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit):
                app_server.main(['--port', '70000'])


if __name__ == '__main__':
    unittest.main()
