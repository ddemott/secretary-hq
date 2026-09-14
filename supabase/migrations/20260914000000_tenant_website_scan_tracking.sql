-- Website-scan re-scan tracking on tenants.
--
-- POST /knowledge/import-website has always been on-demand: owner pastes a URL
-- during onboarding (or later) and we scrape + stage suggestions. There was no
-- durable record of WHICH url was scanned or WHEN, so a periodic re-scan of
-- stale KBs could not exist — the worker would not know who to hit or whether
-- the result was still fresh.
--
-- Two nullable columns, both NULL for every existing tenant (correct: they have
-- never been scanned through a path that stamps these, so the scheduler must
-- skip them until the next successful owner-driven scan writes a URL).
--
-- website_scan_url: the start URL of the last successful scan. Cleared (NULL)
-- means "do not re-scan" — there is no separate opt-out flag; absence of a URL
-- is the opt-out. Re-scan never invents a URL.
--
-- website_last_scanned_at: wall-clock of the last successful scan (manual or
-- scheduled). The worker treats rows older than WEBSITE_RESCAN_STALE_DAYS
-- (default 30) as stale. NULL with a non-NULL url is treated as immediately
-- stale (defensive: should not happen if both are written in the same UPDATE).
ALTER TABLE tenants ADD COLUMN website_scan_url TEXT;
ALTER TABLE tenants ADD COLUMN website_last_scanned_at TIMESTAMPTZ;

COMMENT ON COLUMN tenants.website_scan_url IS
'Start URL of the last successful website knowledge scan for this tenant.
Set by POST /knowledge/import-website and by the website re-scan scheduler on
success. NULL = never scanned (or cleared) — scheduler skips. Absence of a URL
is the opt-out; there is no separate enable flag.';

COMMENT ON COLUMN tenants.website_last_scanned_at IS
'When website_scan_url was last successfully scanned (manual import or
scheduled re-scan). Scheduler re-scans when older than WEBSITE_RESCAN_STALE_DAYS
(default 30). NULL with a URL is treated as stale.';
