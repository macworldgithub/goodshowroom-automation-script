# eraPower customer integration

## Verified pilot milestone on 19 October 2026

This update supersedes the earlier DNS and unverified-read status below.

The live source connection and authenticated Chrome session work. The verified
pilot reader opens Entity Maintenance, searches customers, selects exact source
IDs and reads each selected record's contact and privacy fields. A bounded sample
from site 01 selected nine records: eight were imported, including two companies;
one was skipped because neither a complete personal name nor a business name was
available. No source business record was created or updated.

The backend is configured for scraping with source writes disabled. All eight
records were read back through the authorised customer API and matched against
source IDs, site, contact fields, company names, revision and privacy. Replaying
the original observations preserved eight records without duplicates. After the
frontend rebuild/restart, Customer 360 showed eight named rows, including both
companies, and a customer detail page opened successfully.

    npm run sync:pilot -- --site 01 --query ADAMS --limit 9
    npm run sync:pilot -- --site 01 --use-preview --apply
    npm run integration:check

Private observations and import checkpoints live in ignored .auth files. Do not
commit or share these. The pilot is explicitly a filtered first-page sample, not
a full sync. Broad search returned eraPower's over-1,000-results rejection, so
full reconciliation requires a verified export or complete partitioning strategy.
No automatic inference of positive consent is made from privacy codes. Explicit
restrictions remain enforced; positive mappings need dealer confirmation.

The site switcher omits the active dealership. Discovery now includes the observed
active header, and selecting that already-active site no longer fails.

Checks passed: 27 automation tests, backend source-contract tests, a MongoDB
integration test for company import/replay/search/conflicts, frontend tests,
TypeScript validation and frontend/backend builds. These supplement the live pilot
checks; they do not establish full-site coverage or accepted source write-back.

Next gates: a dealership-nominated test customer/environment for one accepted
write-back, full customer extraction and identity/site semantics, then live stock,
deal, appointment and repair-order mappings. The operator has no dedicated test
customer currently. The source write adapter remains unregistered and disabled.

## Current implementation

Chrome session reuse, backend preflight, customer normalization, bounded customer
imports, configurable pagination, and a resumable scheduled worker are implemented. Existing backend
routes already provide authenticated imports and projection updates, so no backend
or frontend changes were needed for this customer import boundary.

Live inspection on 19 October 2026 found that exported state alone returned to the
Username/Password/Workstation form. The dedicated live Chrome mode then passed
session:test after interactive login. It exposes multiple dealerships; pilot-site
selection and customer-screen mapping are still required. The verified check uses
name:applicationHeader and a visible populated #AppUser. The outer frameset alone
never proves authentication.

## Dedicated live Chrome

Set ERAPOWER_CDP_URL=http://127.0.0.1:9223 and run npm run browser:open. Complete
login/MFA, then leave this window open. Workers attach to the existing application
tab without reloading it and disconnect afterward, leaving Chrome running. The
dedicated profile is .auth/chrome-profile. Only local endpoints are accepted;
never expose this browser-control port remotely.

When ERAPOWER_CDP_URL is empty, session commands use exported browser state. This
mode is retained but is not proven reliable for this eraPower deployment. Neither
mode bypasses authentication challenges or changes session expiry.

## Configure the backend connection

Run npm run backend:connect and sign into the local Good Showroom tab as ADMIN.
The connector reads only the app project's Supabase session cookie and verifies
auth/me before saving an access token in ignored .auth/backend-session.json.
It never prints the token or saves a refresh token. Repeat when the token expires.
The runner also supports the explicit environment settings described below.

Add the GOODSHOWROOM_* entries from .env.example to local .env. Use the actual
organisation and site UUIDs from GET /api/auth/me and an operator's current ADMIN
Supabase access token. Do not use a service-role key. Tokens expire; 401 stops
imports and requires a refreshed operator session. Unattended production needs a
separate least-privilege runner identity, which is not implemented here.

On the backend set INTEGRATION_MODE=scraping and
INTEGRATION_WRITES_ENABLED=false, then restart it. This switches customer views
away from simulation records. Choose a pilot database/site deliberately; the
worker never changes backend mode automatically. There is no simulator fallback.

    npm run sync:preflight

Preflight checks backend reachability, current ADMIN site access, matching
organisation and scraping mode. The backend repeats authorization on every import.

## Verify the customer screen

Finish eraPower login, including Workstation, before saving. Set the authenticated
element in ERAPOWER_READY_SELECTOR, with ERAPOWER_READY_FRAME if needed. Nested
frames need a suitable locator path; the real authenticated hierarchy must be
inspected before configuring it.

Copy customer-profile.example.json to .auth/customer-profile.json. Populate every
required selector from the authenticated customer list; the empty fields are
deliberate, not assumed eraPower mappings. The URL must have the configured
eraPower origin. The source site label must exactly match the mapped pilot site.
Map stable customer IDs, first/last name, and at least email or phone. An optional
attribute property can read an ID from a verified element attribute. Never use a
row number or display name as the source ID.

    npm run sync:customers -- --show
    npm run sync:customers -- --apply

The first command previews a count without importing or printing customer data.
Only --apply writes projections to MongoDB. Reads verify authentication and the
site before and after every page. Configure next only from the inspected next-page
control. Repeated pages, record/page limits, unchanged pagination and site changes
abort extraction. Without next, the reader covers the current page only. Neither
mode deletes missing rows or claims complete reconciliation. Privacy requires
explicit observed-value mappings; contact details never imply consent.

## Import reviewed observations

An operator can import a JSON envelope with siteId, sourceOrigin and customers.
Each customer supplies external_id, first_name, last_name, email and/or phone,
observed_at, and optional privacy matching the backend contract. observed_at must
be the original observation time, not a new timestamp on every retry. Store this
file under ignored reports/ because it contains customer data.

    npm run sync:import -- reports/customers.json
    npm run sync:import -- reports/customers.json --apply

All records are validated before importing; duplicate source IDs abort the run.
Content hashes provide stable revisions. Imports run in batches of 100. Each batch
is atomic in the backend, but a later failure does not roll back earlier batches.
Progress logs report completed batch counts without PII. Rerun the same original
observations after investigating failures; backend upserts preserve customer IDs
and ignore older observations. No automatic retry changes observation timestamps.

## Where records appear

Imported records use the existing customer list and Customer 360 screens for the
mapped site in scraping mode. Existing My Day tasks remain application-owned;
importing customers does not create tasks, appointments or timeline events.

## Remaining integration gates

1. Restore the eraPower connection and verify customer search/detail selectors.
2. Connect a Good Showroom ADMIN session and map all 25 requested source sites.
3. Prove customer import against the real backend and the first mapped site.
4. Map pagination, privacy details and customer vehicles.
5. Inspect the permitted write form; implement one command with revision checks,
   durable submission journal, heartbeat and source read-back before enabling writes.
6. Expand stock/deals/appointments/repair orders and full scheduled reconciliation.

## Live verification status

The dedicated Chrome session passed session:test and discovery found 25 entries.
Switching to source 01 was verified against the header. Entity Maintenance opened
with stable field IDs for entity ID, first/last names, email, phones and privacy.
Customer search has not been verified: eraPower subsequently displayed Network
Connection Lost, with an overlay preventing interaction. The authentication check
now explicitly stops on that outage even if the user header is still populated.

The operator then signed in with ADMIN access. backend:connect verified the
session and saved the operator access token locally without printing it. All 25
source sites were provisioned and mapped to distinct Good Showroom sites through
the authenticated ADMIN API. The pre-existing app site was retained. sites:status
verified discovered=25 and mapped=25. No customer import or source write-back has
been performed.

The remaining source blocker was diagnosed on 19 October: refreshing eraPower
returned ERR_NAME_NOT_RESOLVED. Both the system resolver and an explicit public
resolver returned DNS name does not exist for the configured hostname. Confirm
the current source URL or restore its network access before further browser
mapping. npm run source:check provides a credential-free DNS diagnostic. Backend
site provisioning did not require a functioning eraPower connection because it
used the already-observed site inventory.

The scope was expanded by the user to all available sites. sites:discover saves
observed codes and labels in .auth/era-sites.json; sites:status prints the mapped
count. sync:all validates the entire inventory and per-site profiles before any
import. Backend IDs must be unique per source site. The original backend contract
rejects external customer IDs already owned by another site; determine whether
eraPower Entity IDs are group-global or branch-local before group imports. Do not
invent a new identity scheme or merge/reassign customers to bypass that conflict.

sites:map previews exact backend name matches; --apply persists them, while
--apply --create additionally provisions missing Good Showroom sites. Site
creation has a durable pending journal. A missing response requires reconciliation;
it is not retried as another creation. This only affects app site metadata and
does not write to eraPower. Provisioning and mapping have now completed for all
25 observed sites; this is site metadata, not completed customer synchronization.

## Scheduled reads and recovery

    npm run sync:once
    npm run sync:once -- --apply
    npm run sync:watch

The first command previews; --apply imports. The watch command runs every 300
seconds by default (GOODSHOWROOM_SYNC_INTERVAL_SECONDS, 30 to 3600). It checks
backend access each cycle and stops on errors. Logs contain counts and phases,
not customer details. .auth/worker-status.json contains the last cycle status.

Before imports the worker saves original observations in
.auth/customer-import.json and checkpoints each accepted batch. Restart with
--apply to resume without scraping again or changing observation timestamps.
Replaying a batch whose acknowledgement was lost uses the backend's existing
upsert protection. The checkpoint is tied to the backend, organisation, site and
source origin; moving it across sites is refused. The checkpoint is deleted on
completion. Customer data remains private inside ignored .auth.

Only one worker may run: .auth/customer-worker.lock prevents overlap. If a process
is forcibly killed, verify that its recorded PID is no longer running before
manually removing that exact lock file. Lock removal is deliberately not automatic.

## Write runner foundation

command-runner.mjs supports claims, lease heartbeats, durable submission journals,
result reporting and uncertainty handling. A journal with a saved result is
reported again without repeating the browser action. An incomplete journal stops
for reconciliation. Source outcomes and backend command status are returned
separately: a source report never overrides a backend needs_review status.

There is intentionally no live write adapter or command-processing CLI yet.
runCommand refuses to claim without a verified adapter implementing assertReady,
execute and supported kinds. The adapter must check source revisions, call the
beforeSubmit boundary before any mutation, respect its abort signal and reread
the source record. Only mapped, live-tested operations can be registered.
No business records have been changed in eraPower by this implementation.

Run npm test for normalization, permissions, transport and batching checks. These
use synthetic observations and a mocked backend; they are not live acceptance.
