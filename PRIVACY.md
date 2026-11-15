# SIS Login Fix privacy policy

Updated November 15, 2026.

SIS Login Fix runs on Charles University SIS (is.cuni.cz/studium/), WebApps
(is.cuni.cz/webapps/), and CAS (cas.cuni.cz/cas/). It reads the page URL and the
login and logout elements to tell whether you are signed in.

To fix sessionless and expired links, it saves session IDs from university URLs,
the SIS tid parameter, timestamps, and retry state in is.cuni.cz localStorage
and per-tab sessionStorage. None of this is synced by the browser. A per-tab
retry entry also keeps the target path and its non-session query parameters, so
an unrelated page is not taken for the result of that retry.

When it redirects www.is.cuni.cz to is.cuni.cz, it keeps a move count in that
tab's www.is.cuni.cz sessionStorage to stop redirect loops. The URL is not
stored.

SIS and WebApps URLs that change something, like course enrollment or deletion,
are left alone. The exception is a link you clicked yourself on a signed-in SIS
page. Its destination and session ID are kept in is.cuni.cz localStorage for up
to 5 minutes, so the action can run once after you sign in again. The entry is
removed when the action runs or when you sign out of SIS.

On CAS, it changes attributes on the one-time-code field and the helper elements
around it, so password managers and phone keyboards treat it as a 2FA code
field. It never reads, stores, generates, or submits passwords or one-time
codes.

Neither the extension nor the userscript sends any data off your device. There
are no analytics, telemetry, ads, or remote scripts, and no data is sold or
shared. Stored session IDs are only used to open is.cuni.cz pages over HTTPS.
Normal requests your browser makes to university servers fall under Charles
University's own rules.

Entries expire after 12 hours for active sessions, 24 hours for rejected session
IDs (up to 8 per service), 5 minutes for per-tab retry state, 10 seconds for the
www redirect count, and 5 minutes for clicked actions (up to 8). Expired entries
are ignored and later overwritten. Nothing deletes them in the background. To
clear everything now, disable SIS Login Fix and clear site data for is.cuni.cz
in your browser. This also clears other SIS site data and may sign you out.
Uninstalling alone does not clear site storage.

Issues: https://github.com/Addenda-Carolina/addenda/issues
Issues are public.
Policy: https://addenda.rychle.info/sis-login-fix/privacy/

Copyright (C) 2026 skrblk. Licensed under GPL-3.0-or-later.
Independent project, not affiliated with Charles University.
