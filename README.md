# Addenda Carolina

Browser fixes for Charles University. For now that means SIS Login Fix.

SIS (`is.cuni.cz/studium/`) and WebApps (`is.cuni.cz/webapps/`) put the session
token in the URL (`?id=...` and `/webapps/UKSESSION.../`). Open a bookmark, a
shared link, or an old tab and you get a logged-out page, even if you are signed
in elsewhere. CAS (`cas.cuni.cz`) also marks its 2FA code input as a password
field with autocomplete turned off.

SIS Login Fix repairs those links in your browser and fixes the CAS code field.
There is no popup and nothing to set up.

## What it does

- Adds your session ID to SIS and WebApps links that are missing one, and
  redirects `www.is.cuni.cz` to `is.cuni.cz`. The redirect is capped per tab, so
  a server bounce cannot loop.
- Replaces an expired session ID only after the page loads logged out. Tabs left
  on a logged-out page pick up the new session when you sign in again in another
  tab. A module menu `KEY` belongs to the login that issued it, so it is dropped
  whenever the session ID changes.
- Ignores pages restored from the back/forward cache, so going back cannot
  overwrite a newer session. Stops retrying if SIS rejects a session.
- Leaves URLs that change something (`do_*.php`, course enrollment, deletion)
  alone. The one exception is a link you clicked yourself on a signed-in SIS
  page whose session expired before it loaded. If you sign in again within 5
  minutes of the click and did not sign out in between, it opens once with the
  new session.
- Sets `type="text"`, `autocomplete="one-time-code"`, and `inputmode="numeric"`
  on the CAS `token` field. It does not read or submit credentials.

## Install

- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/sis-login-fix/)
- [Chrome Web Store](https://chromewebstore.google.com/detail/clhjgikehnkeonklmokglcmnabcoljam)
- [Userscript (`sis-login-fix.user.js`)](https://github.com/Addenda-Carolina/addenda/releases/latest/download/sis-login-fix.user.js) for [Violentmonkey](https://violentmonkey.github.io/) or Tampermonkey
- [GitHub Releases](https://github.com/Addenda-Carolina/addenda/releases/tag/v1.0.0) with `SHA256SUMS.txt` and OpenPGP signatures ([`skrblk.asc`](https://addenda.rychle.info/skrblk.asc))

Use the extension or the userscript, not both in the same browser profile.

## Build from source

Needs Node.js 22.16 or newer.

```sh
npm ci
npm run build
npm test
```

`npm test` type-checks, builds, and runs the tests in `tests/`. The build writes
unpacked extensions to `dist/chrome/` and `dist/firefox/`, and the userscript to
`dist/sis-login-fix-1.0.0.user.js`.

## Privacy and issues

Session state is kept only in `is.cuni.cz` `localStorage` and `sessionStorage`.
Nothing is sent off your device. Passwords and one-time codes are never read or
stored. Details are in [PRIVACY.md](PRIVACY.md).

Report bugs on [GitHub Issues](https://github.com/Addenda-Carolina/addenda/issues).
Issues are public.

## License

Copyright (C) 2026 skrblk. Licensed under [GPL-3.0-or-later](LICENSE).
Independent project, not affiliated with Charles University.
