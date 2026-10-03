"""Check the static Pages payload. Python standard library only."""
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit
import re
import unittest

ROOT = Path(__file__).resolve().parents[1]
SITE = ROOT / 'site'
PAGES = ('index.html', 'sis-login-fix/privacy/index.html')

class Markup(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.elements = []
        self.feed(text)
    def handle_starttag(self, tag, attrs):
        self.elements.append((tag, dict(attrs)))

class SiteChecks(unittest.TestCase):
    def test_public_payload(self):
        actual = {p.relative_to(SITE).as_posix() for p in SITE.rglob('*') if p.is_file()}
        self.assertEqual(actual, {*PAGES, 'styles-0.1.0.css'})

    def test_markup_and_no_active_content(self):
        for name in PAGES:
            with self.subTest(page=name):
                text = (SITE / name).read_text()
                nodes = Markup(text).elements
                self.assertTrue(text.lower().startswith('<!doctype html>'))
                self.assertIn(('html', {'lang': 'en'}), nodes)
                for tag in ('title', 'main', 'h1'):
                    self.assertEqual(sum(t == tag for t, _ in nodes), 1)
                self.assertTrue(any(t == 'meta' and a.get('name') == 'viewport' for t, a in nodes))
                for tag, attrs in nodes:
                    self.assertNotIn(tag, ('script', 'iframe', 'form', 'object', 'embed'))
                    self.assertFalse(any(key.startswith('on') for key in attrs))
                    self.assertNotEqual(attrs.get('http-equiv', '').lower(), 'refresh')
                    for key in ('href', 'src'):
                        value = attrs.get(key)
                        if not value:
                            continue
                        url = urlsplit(value)
                        if url.scheme or url.netloc:
                            self.assertEqual(tag, 'a', 'No external resources may load automatically')
                            self.assertEqual(url.scheme, 'https')
                        else:
                            target = ((SITE / name).parent / url.path).resolve()
                            self.assertTrue(target.is_relative_to(SITE.resolve()))
                            self.assertTrue(target.is_file() or (target / 'index.html').is_file(), value)

    def test_policy_scope_and_deletion_disclosure(self):
        text = (SITE / PAGES[1]).read_text()
        for phrase in ('This policy covers the SIS Login Fix extension and userscript',
                       '12 hours', '24 hours', '5 minutes', 'not scheduled deletion',
                       'Uninstalling', 'is.cuni.cz', 'cas.cuni.cz', 'GitHub Pages',
                       'No extension data is sent to the maintainer'):
            self.assertIn(phrase, text)
        self.assertIn('https://github.com/Addenda-Carolina/addenda/issues', text)
        self.assertNotRegex(text, r'version[ \n]+[0-9]+\.[0-9]+\.[0-9]+')

    def test_deployment_is_limited_to_site_and_checks_https(self):
        workflow = (ROOT / '.github/workflows/static.yml').read_text()
        self.assertIn('path: site', workflow)
        self.assertIn('python3 tools/check-site-0.1.0.py', workflow)
        self.assertNotIn("path: '.'", workflow)
        self.assertIn("--proto '=https'", workflow)
        self.assertIn('cmp site/sis-login-fix/privacy/index.html', workflow)
        self.assertNotIn('::warning::HTTPS', workflow)

if __name__ == '__main__':
    unittest.main(verbosity=2)
