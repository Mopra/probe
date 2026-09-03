# probe runbook

Setup, deploy, and what to do when it misbehaves. PLAN.md is the specification;
this is the operational counterpart to §5, §12 and §13.

If you are here to go live, go straight to **§6**. It is the whole sequence, in
order, with the commands.

---

## 1. Order of operations

Only one item has a lead time measured in days, so start it first.

1. **Book the legal hour.** §9.4. Four concrete questions, not an open-ended
   worry. This is the only hard prerequisite you cannot do yourself.
2. Postgres (currently Neon), schema applied, config seeded.
3. Day3 account, sending domain verified, API key, webhook endpoint.
4. SES inbound receipt rule for replies, in the Day3 AWS account.
5. Vercel project for `apps/web`, Cloudflare Access in front of it.
6. VPS for `apps/worker` under systemd.
7. Two weeks in the dry-run harness.
8. §6, in order.

**There is no separate AWS account to create and no SES production access to
request.** probe sends through Day3, which already owns the SES account, the
verified domains and the reputation. See PLAN.md §5.1 for why, and for what that
costs.

---

## 2. Day3

probe is a tenant of Day3 like any other caller of its API. What it needs from
the dashboard is a verified domain, a key, and a webhook.

### 2.1 The account

Use a **Day3 account of its own** for probe, not the one exit1's alerts run
through. Day3 scopes suppressions, risk status, the sending-enabled flag and the
monthly allowance per account, so a separate account gives probe the isolation
the separate AWS account used to buy. The underlying SES reputation is still
shared, which is why §5.5's complaint rule is as tight as it is.

### 2.2 The sending domain

| Product   | From                    |
|-----------|-------------------------|
| exit1.dev | `morten@mail.exit1.dev` |
| day3.app  | `morten@mail.day3.app`  |

Root domains are never used for sending. Per-product subdomains so a problem on
one does not contaminate the other.

Add `mail.exit1.dev` under **Domains** and follow what Day3 asks for. It
publishes the DNS records and checks them itself; there is no DKIM, MAIL FROM or
DMARC to assemble by hand. Any local part on a verified domain works, with no
pre-created sender.

A `from_email` on an unverified domain gets a synchronous `403
domain_not_verified`, which lands on the send row as its error, so it is visible
on `/sends` rather than silent.

Before sending anything real, send one message to a `mail-tester.com` address
and one to a Gmail account, and check that SPF and DKIM both pass with the right
domain in the received headers.

### 2.3 The API key

**API keys** in the Day3 dashboard. `day3_live_…`, into `DAY3_API_KEY` in the
worker's `.env`. A `day3_test_…` key is rejected by Day3 and by `cli preflight`.

The key never reaches `apps/web`: only the worker sends.

The API is on **`go.day3.app`**, which is what `DAY3_API_BASE_URL` defaults to.
The apex `day3.app` serves the marketing site and returns a 404 HTML page for
`/api/v1/emails`, so pointing at it fails every send in a way that looks like a
routing problem rather than a configuration one. Check a deployment with:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  https://go.day3.app/api/v1/emails          # 401 unauthenticated, 400 with a good key
```

### 2.4 The webhook

Create a webhook endpoint pointing at `https://<web-host>/hooks/day3` and
subscribe it to exactly:

```
email.delivered   email.bounced   email.complained   email.failed
```

Day3 shows the signing secret (`whsec_…`) **once**. Put it in
`DAY3_WEBHOOK_SECRET` in the worker's `.env` **and** in Vercel, because the
endpoint that verifies it runs on Vercel.

`/hooks/day3` fails closed on a missing secret. Without it, bounces and
complaints never reach the suppression list and the §5.5 auto-pause is blind,
which is a compliance problem rather than a metrics one.

Do **not** enable open tracking. §8.7: Apple Mail Privacy Protection made the
number meaningless and the pixel is a small deliverability negative for no
information. Clicks go through probe's own `/c/:token`.

### 2.5 Replies, which Day3 does not do

Day3 has no inbound side, so this is the one part of the mail path probe still
owns directly.

`morten@mail.exit1.dev` must be a live mailbox. In the **Day3 AWS account**,
where the domain identities already are: an SES inbound receipt rule, in this
order, writing to S3 and then publishing to SNS, with the topic subscribed to
`https://<web-host>/hooks/ses`.

Put the topic ARN in `SNS_ALLOWED_TOPIC_ARNS`. This is **required**: the
endpoint refuses everything when it is empty. A valid SNS signature only proves
a message came from SNS, not that it came from your topic, and anyone with an
AWS account can create a topic and post forged bounces, each of which writes a
permanent suppression with no resubscribe path.

The handler runs §5.3 in order:

1. **Filter auto-replies.** An `Auto-Submitted` header with any value other than
   `no`, a `Precedence` of `bulk` or `auto_reply`, or an `X-Autoresponse` /
   `X-Autoreply` header marks the message automated. Automated mail is forwarded
   but never suppresses and never counts as a reply. An out-of-office must not
   burn a contact or inflate the one metric that matters.
2. **Suppress.** A genuine reply inserts a suppression with `reason = 'replied'`
   before anything else happens.
3. **Forward** to the real inbox either way.

If a *delivery* notification ever arrives on `/hooks/ses`, it is recorded and it
still suppresses (dropping a real bounce would be worse), but it logs at error
level: some topic is publishing delivery events to the inbound endpoint, and
until it is unsubscribed the rates on `/health` are double counting.

---

## 3. The exit1 generator

probe never writes copy. It asks a product for a finding (§6), and exit1 answers
from `functions/src/probe-generate.ts`.

**probe calls the Cloud Function directly**, not `exit1.dev/api/probe/generate`.
exit1.dev is served by Vercel with no `vercel.json`, so every Firebase Hosting
rewrite in that repo is inert -- which is a pre-existing consequence of the
Vercel migration and affects exit1's other endpoints too, not just probe's. The
generator call is machine to machine, so the URL only has to work:

```
https://europe-west1-exit1-dev.cloudfunctions.net/probeGenerate
```

That is what `generator_url` in `probe.toml` points at. If exit1.dev ever gets a
`vercel.json` with a rewrite, switch it back and nothing else changes.

The endpoint is publicly reachable, so the HMAC signature is the entire gate.
Set the **same value** as probe's `PROBE_HMAC_SECRET` on the exit1 side:

```bash
cd exit1.dev/functions
firebase functions:secrets:set PROBE_HMAC_SECRET
firebase deploy --only functions:probeGenerate,functions:probeEvidence
```

A Firebase secret only reaches a function when that function is redeployed after
the secret is set. A mismatched secret makes every generator call come back 401,
which probe records as `generator_failed` after three attempts. If `/health`
shows nothing but `generator_failed`, check this first.

To verify the whole path without the worker, send one signed request by hand:

```bash
SECRET=$(grep ^PROBE_HMAC_SECRET= .env | cut -d= -f2-)
BODY='{"lead_id":"smoke","product":{"name":"Example","url":"https://example.com","description":null,"source":"manual","launched_at":null,"tags":[]},"recipient":{"first_name":null}}'
TS=$(date +%s)
SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.*=[ ]*//')"
curl -sS -w '\nHTTP %{http_code}\n' -X POST \
  https://europe-west1-exit1-dev.cloudfunctions.net/probeGenerate \
  -H 'content-type: application/json' \
  -H "x-probe-timestamp: $TS" \
  -H "x-probe-signature: $SIG" \
  --data "$BODY"
```

**200 is the success case**: the signature verified and the generator produced
something, either a severity 1 defect or a severity 0 clean report. 204 now means
only that the site could not be measured at all. 401 means the secrets differ.
400 means the signature was fine and the body was not.

### The evidence report

`probeEvidence` holds the public report every email links to: no signup, no email
capture, no tracking (§9.2.3). Reports live in the `probeFindings` Firestore
collection, written by `probeGenerate` before it answers, so the link in an email
can never 404.

It is served to recipients through **probe's own** `/e/:id`, which proxies to the
function. Same reason as above: `exit1.dev/probe/<id>` would need a Vercel
rewrite on the marketing site. `probe.exit1.dev/e/<id>` is a subdomain of
exit1.dev, so the link still reads as ours, and the whole evidence path stays
inside probe where it can change without touching exit1.dev.

Two overrides if that ever moves: `PROBE_EVIDENCE_BASE` on the exit1 side is the
URL the generator puts in the email; `PROBE_EVIDENCE_ORIGIN` on probe's side is
the upstream the proxy fetches.

---

## 4. Database

Any Postgres. Currently **Neon**, in a region close to the VPS. The variable is
still called `SUPABASE_DB_URL` for historical reasons; it takes any Postgres
connection string.

Two connection strings matter, and they are not interchangeable:

- The **direct** (unpooled) host for `apps/worker` and for migrations.
- The **pooled** host for `apps/web` on Vercel, whose serverless functions open
  many short-lived connections.

The client detects the pooled host by the literal string `pooler` in the
hostname and turns prepared statements off for it, because a transaction pooler
cannot serve a named prepared statement. Neon's pooled host is
`...-pooler.<region>.aws.neon.tech`, so that detection works unchanged.

```bash
SUPABASE_DB_URL='postgres://...' pnpm migrate --dry   # list pending
SUPABASE_DB_URL='postgres://...' pnpm migrate         # apply
SUPABASE_DB_URL='postgres://...' pnpm seed            # upsert campaigns from probe.toml
```

`pnpm seed` never touches `paused` or `warmup_start`. Campaigns are born paused
and stay paused until someone deliberately unpauses them.

Migration `0002_day3_sending` makes the send claim atomic and adds the provider
id columns. It is safe to re-run and safe to run on a live table.

Nothing uses RLS. Both apps talk to the database server-side only with the
service role, and nothing database-facing ever ships to the client. If
`apps/web` ever grows client-side data access, that decision gets revisited
before the code does.

---

## 5. Deploying the two apps

### 5.1 apps/web on Vercel

Root directory `apps/web`, build command `pnpm build` from the repo root (the
workspace packages must compile first), install command `pnpm install`.

Environment: `SUPABASE_DB_URL` (pooler), `PROBE_HASH_PEPPER`,
`PROBE_HMAC_SECRET`, `PROBE_PUBLIC_URL`, `PROBE_APPROVER`,
`DAY3_WEBHOOK_SECRET`, `SNS_ALLOWED_TOPIC_ARNS`, `CF_ACCESS_REQUIRED=true`,
`CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD`, `CF_ACCESS_ALLOWED_EMAILS`.

### 5.2 Cloudflare Access

The dashboard holds every founder's plaintext address probe has resolved.
Personal data on an unauthenticated public URL is a problem regardless of
whether anyone finds it.

The app **verifies Cloudflare's signed assertion**; it does not trust the
identity header. `Cf-Access-Authenticated-User-Email` is set by Cloudflare, but
a request reaching the Vercel origin directly — the `*.vercel.app` hostname, or
a preview deployment's own hostname — never passed through Cloudflare and can
set that header to anything. So:

1. Create an Access application in front of the host.
2. Copy its **AUD tag** (Overview tab) into `CF_ACCESS_AUD`. This is checked on
   every request, and it is not optional: every application in a Cloudflare team
   is signed by the same keys, so a token minted for any other application in
   your account would otherwise verify perfectly.
3. Put the team domain in `CF_ACCESS_TEAM_DOMAIN`.
4. **Bypass** these paths, which must remain public:

   ```
   /u/*        unsubscribe
   /c/*        click redirect
   /data       the Article 14 notice
   /e/*        the evidence report, which is THE link in every email
   /hooks/*    Day3 and SNS, which verify their own signatures instead
   ```

   In the current Zero Trust UI a Bypass policy applies to a whole application,
   not to a path, so these live in a SECOND application (`probe-public`) whose
   destinations are `probe.exit1.dev` with a Path of `u`, `c`, `data`, `e` and
   `hooks`, and whose single policy is Bypass / Everyone. Access matches the
   most specific path first, so those five hit the bypass app and everything
   else stays gated. Allow a minute for the change to propagate.

5. Turn on **Vercel Deployment Protection** as well, so the origin is not
   reachable without Cloudflare in front of it. Belt and braces: step 2 is what
   makes the app safe if the origin ever is reachable.

If `/u/:token` 404s while a batch is in flight, that is a compliance incident,
not a bug. The route is written so an unknown or already-used token still
returns a friendly 200; keep it that way.

### 5.3 apps/worker on the VPS

```bash
git clone <repo> /opt/probe && cd /opt/probe
pnpm install --frozen-lockfile
pnpm build
install -m 600 .env /opt/probe/.env
mkdir -p /opt/probe/outbox
sudo cp deploy/probe-worker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now probe-worker
journalctl -u probe-worker -f
```

The unit runs `node apps/worker/dist/index.js`, which registers the cron
schedule and starts the send daemon. On boot, when `PROBE_SEND_ENABLED=true`, it
runs the send preflight and **refuses to start** if anything is not usable. A
failed unit there is the intended outcome: every fault it catches produces mail
that looks fine in the log and is broken in the inbox.

It also resolves any send left in `sending` by a previous process, marking each
one failed so it stops holding a contact-once slot.

Everything the worker does is runnable one-shot, which is what you want when
debugging. Never debug by waiting for 06:30:

```bash
pnpm --filter @probe/worker cli preflight   # check everything before going live
pnpm --filter @probe/worker cli sweep
pnpm --filter @probe/worker cli resolve
pnpm --filter @probe/worker cli generate
pnpm --filter @probe/worker cli send        # ONE send per campaign per run
pnpm --filter @probe/worker cli health
```

Logs are JSON lines on stdout, so `journalctl -u probe-worker -o cat | jq` works.

---

## 6. Going live

§13 M6, in this order and no faster. Each step is checkable, and the next one
does not work until the previous one is done.

### Step 0. Legal review done

§9.4, four questions. The downside here is a per-email fine, not a poor reply
rate. Nothing below matters if this has not happened.

### Step 1. A real postal address

Edit `postal_address` in `probe.toml`. This is the one line you must change.

The copy lint rejects a placeholder, so until it is a real address, every email
fails at generation, at approval and at dispatch. Check it:

```bash
pnpm dry-run     # every fixture should stop reporting placeholder_postal_address
```

### Step 2. Two weeks of dry-run output, read by eye

```bash
pnpm dry-run                                          # the built-in fixtures
pnpm --filter @probe/worker cli dry-run --from-db      # every ready proof
```

Open the `.eml` files in a real mail client. Both parts. Click every link and
confirm they point at your real host.

The question you are answering is not "does it render" but **"would I thank a
stranger for this email"**.

The `.eml` is a faithful preview, not the exact bytes: Day3 assembles the MIME
envelope now (§5.1). The subject, both bodies and the unsubscribe target are
byte-identical to what is sent.

### Step 3. Preflight clean

```bash
pnpm --filter @probe/worker cli preflight
```

It checks, and exits non-zero on any of:

- `DAY3_API_KEY` present and shaped like a live key
- `DAY3_WEBHOOK_SECRET` present, so bounces can reach the suppression list
- the public base url is https and is not localhost
- `postal_address` is a real address

and then prints the campaign state: paused or live, and whether warmup has
started.

### Step 4. Start warmup on exactly one campaign

```bash
pnpm --filter @probe/worker cli warmup exit1
```

**This is not optional and nothing else substitutes for it.** Without a
`warmup_start`, the daily cap is 0 for every day, the send loop reports
`cap_reached` forever, and not one email leaves however much is queued. The
dashboard shows it as gate 3 of the dispatch interlock, and there is a
**Start warmup** button next to the campaign for the same job.

Warmup does not unpause. The curve, which has no manual override:

| Days  | Daily cap |
|-------|-----------|
| 1-3   | 5         |
| 4-7   | 10        |
| 8-14  | 20        |
| 15-21 | 35        |
| 22+   | 50        |

Each sending subdomain is paced independently. They are separate reputations and
one queue must never starve the other.

`day3` stays paused, unstarted and NOT routable: `day3.app/api/probe/generate`
does not exist at all, so there is nothing for it to say (§6.9).

### Step 5. Unpause the one campaign

On `/`, the **Resume** button next to `exit1`.

### Step 6. Flip the switch

`PROBE_SEND_ENABLED=true` in the worker's `.env`, then
`systemctl restart probe-worker`. Watch the boot line: it logs at **warn** level
with `send_enabled: true` and the public base url it will put in every email.

All three gates on the dashboard interlock should now read closed.

### Step 7. Five a day for three days

Read every single email before approving it. Watch bounces obsessively.

Note that `a` in `/queue` approves with no confirmation. On the day you are
reading every email before approving, that is one keystroke between reading and
sent.

---

## 6.5 The end-to-end rehearsal

Do this once before step 7, and again after any change to the send path. It
answers the question `pnpm dry-run` cannot: does a real email, generated from a
real finding, actually arrive in a real inbox and look right there.

```bash
pnpm --filter @probe/worker cli smoke https://some-product.com --to you@example.com --name You
```

The product is one you choose. The address is yours. Everything between them is
the production path: `smoke` inserts the lead and pins the contact to the
address you named, and that is the only thing it does that the pipeline would
not do for itself. The cascade is the one step it stands in for, because the
cascade would find the founder and the whole point is that this lands with you.

It runs the whole thing and does not come back until the email has been sent, or
until something has stopped it and said what. There is nothing to poll, nothing
to approve and no second command. It takes a few seconds: exit1's generator is
synchronous and answers 200 or 204 in one call.

```
lead     <id>  some-product.com  new
to       you@example.com
country  US (whois)
status   contact_resolved

generating...

finding ready.
sending...

SENT to you@example.com
  subject      Your signup form accepts an unverified address
  provider id  eml_...
```

Then read what arrives. Both parts, every link, the unsubscribe especially.

The one thing it needs is `PROBE_SEND_ENABLED=true`. It says so and stops
otherwise, leaving the proof ready in `/queue`.

What it skips, and only this: the send window, the daily cap, the pause flag and
the pacing gap. Those exist to spread strangers' mail across a day at a
reputation-safe rate, and none of that describes one message you addressed to
yourself and are sitting there waiting for. What it does not skip is everything
about who may be emailed and whether the message is fit to send: the global kill
switch, jurisdiction, suppression checked on both sides of the contact and again
at dispatch, contact-once, the copy lint, and the atomic claim. Those apply to a
test exactly as they apply to a stranger.

Approval is recorded as `smoke:<approver>` rather than as a person, so `/sends`
never implies somebody read this one in the queue. Nobody did.

Finding a target that survives the gate is the fiddly part, so check before you
commit to one. This writes nothing and creates no lead:

```bash
pnpm --filter @probe/worker cli smoke https://some-product.com --check
```

Under the blocklist almost everything passes, `unknown` included, so this is now
a quick sanity check rather than a hunt. It still earns its place: a German or
Danish product is refused, and finding that out without creating a lead is the
difference between picking another target and burning a domain.

Four things about the target are worth knowing before you pick one:

- **It cannot be Danish or German, and it cannot be ours.** `blocked_countries`
  is `["DK", "DE"]`, and the loader refuses to start if `DK` ever leaves it, so
  there is no way to rehearse against our own sites. `optipeople.com` reads
  Denmark off its own imprint and stops there.
- **Unknown now passes.** A domain whose country cannot be established is
  contactable under the blocklist, which is most of them.
- **It cannot be a platform.** `github.com`, `anyone.github.io`, a Substack, a
  Netlify demo: those are dropped as `platform_domain` at sweep and again at
  resolve. The domain belongs to GitHub, not to the founder.
- **The generator has to find something.** No proof, no email (§3.1 rule 1). A
  clean site now produces a severity 0 report rather than nothing, so the
  rehearsal still ends in an email. `no_proof` is reserved for a site that could
  not be measured at all.
- **A dropped lead stays dropped.** `drop_reason` is permanent and never
  overwritten. A second rehearsal wants a different product, and it is why
  `--check` exists: hunting for a target with the real command burns a domain
  per attempt, including domains that might launch something worth writing
  about later. `cli requalify` brings back only leads the jurisdiction rule
  dropped, and only when that rule has since changed.

Afterwards, release your own address:

```bash
pnpm --filter @probe/worker cli erase you@example.com --yes
```

Without that, contact-once refuses the next rehearsal to the same inbox, which
is `sends_email_hash_uniq` doing its job on you rather than on a stranger.

---

## 6.6 Platform domains

A Show HN link is as often a repository, a profile or a hosted demo as it is a
product. `github.com`, `doruksega.github.io`, `eito.substack.com`,
`wasm-gguf.netlify.app`: the thing behind the link may be real, but the domain
belongs to GitHub or Substack or Netlify, so the contact cascade finds their
address and the generator reports on their infrastructure.

`PLATFORM_DOMAINS` and `PLATFORM_PARENTS` in `packages/core/src/url.ts` are the
list. Sweep refuses to store them and resolve drops them as `platform_domain`,
so both new and existing leads are covered. Add to the list as new ones appear;
it is plain code and needs no migration.

For leads that were already past resolve when the list changed:

`cli reconcile` picks them up (§6.8). It fails any proof still generating,
because a pending proof outlives its lead's status: `duePendingProofs` reads the
proofs table and never looks at the lead.

## 6.7 Changing the jurisdiction rule

`blocked_countries` in `probe.toml`. Adding a country takes effect on the next
resolve and needs nothing else: leads already past the gate are unaffected,
which is correct, because they were judged under the rule in force when they
were swept.

Removing one is the case that needs a second step. Every lead the old rule
dropped carries `drop_reason = 'jurisdiction_blocked'` and status `dropped`, and
resolve only ever reads `discovered` and `matched`, so those leads are invisible
forever unless they are brought back:

`cli reconcile` picks them up (§6.8), and it is the only place `drop_reason` is
ever cleared. Deliberately narrow: only `jurisdiction_blocked`, and only where
the current blocklist does not block the country that was recorded. A lead
dropped as `suppressed`, `no_contact` or `contacted_other_campaign` was judged
on its own merits and stays dropped. A suppression is permanent under rule 2 and
nothing in this command can touch it.

Note what a widened rule means for leads swept months ago: their contact was
never resolved, so they go back through the full cascade, and their jurisdiction
is guessed again from a site that may since have changed.

---

## 6.8 `cli reconcile`

One command for "the rules changed, fix the rows that were decided under the old
ones". It replaced three separate repair commands, because the first question
was always which one to run.

```bash
pnpm --filter @probe/worker cli reconcile        # the plan
pnpm --filter @probe/worker cli reconcile --yes  # do it
pnpm --filter @probe/worker cli resolve          # then put them through the rules
```

Three repairs, each narrow:

| Repair | What it catches |
|---|---|
| Platform domains | A repo, profile or hosted demo swept before the denylist existed |
| Stranded leads | A lead on a campaign that is no longer `routable` |
| Jurisdiction requalification | A lead the old blocklist dropped that the current one allows |

What it never touches: suppressions, anything already sent, and a lead dropped
on its own merits. `no_contact`, `no_proof` and `contacted_other_campaign` are
verdicts on the lead rather than on a rule, and they stand.

A stranded or requalified lead goes back to `discovered` with its campaign
cleared, so the next resolve routes it from scratch. Any proof still running for
a lead being dropped or rerouted is failed first: a pending proof outlives its
lead's status, because `duePendingProofs` reads the proofs table and never looks
at the lead.

---

## 6.9 Campaigns that cannot generate

`routable` in `probe.toml`, and a column on `campaigns`. It is not `paused`:
pausing gates **sending** and deliberately leaves routing alone, so a paused
campaign keeps filling its queue while no mail goes out. `routable = false` is
the other thing, "send no leads here at all".

`day3` is the case it was written for. `day3.app` has no
`/api/probe/generate`, so the generator URL returns the marketing site's 404
page. Matching is round robin, so half of every intake went there: 29 of the
first 61 leads, and each one that reached a generator call spent three attempts
collecting 404s. Nothing on `/health` said so, because they showed as `pending`,
which reads like work in progress rather than a URL that never existed.

Flip it to `true` the day the endpoint ships, then `cli seed`.

---

## 7. When it misbehaves

### Stop everything, now

Three levers, in increasing order of bluntness:

1. The big red button on `/`, which sets `paused = true` on every campaign.
   Sends already dispatched are gone; everything queued stops.
2. `PROBE_SEND_ENABLED=false` in the worker environment, then
   `systemctl restart probe-worker`. Checked before every single send.
3. `systemctl stop probe-worker`. Nothing runs at all, including sweeps.

Use 1 first. It is reversible from the UI and it leaves the record intact.

There is a fourth, outside probe: Day3's own admin pause on the account, which
stops sending whatever probe thinks.

### Nothing is sending and there is no error

Almost always warmup. Check the dispatch interlock on `/`: if gate 3 reads open,
run `cli warmup <slug>`. `cli preflight` says the same thing in one line.

Otherwise, in order: is `PROBE_SEND_ENABLED` exactly `true`; is the campaign
unpaused; is it a weekday between 09:00 and 16:00 Copenhagen; is `sent_today`
already at the cap.

### A send is stuck

```bash
pnpm --filter @probe/worker cli stuck            # list
pnpm --filter @probe/worker cli stuck --yes      # resolve to failed
```

A row in `sending` means a worker died between claiming the send and hearing
back from Day3. Whether the message went out is genuinely unknown, so look the
send ids up in the Day3 dashboard first. Resolving marks each one failed, which
releases its contact-once slot and returns its proof to `/queue` for a
deliberate re-approval. Nothing is ever re-sent automatically: a founder getting
the same probe report twice is the mistake that would actually embarrass us.

The worker does this itself on boot, so this command is for a running daemon.

### Complaint or bounce rate rising

`/health` shows both rolling rates against the auto-pause thresholds, which are
half of AWS's (0.05% complaints, 3% hard bounces). The `autopause` job pauses
the campaign automatically when either is crossed, **and on any complaint at
all**, whatever the rate works out to (§5.5).

Only hard bounces count. A transient bounce is a full mailbox or a greylist; it
is recorded and visible in the event trail on `/sends`, and never acted on.

If bounces are rising, the contact cascade is producing bad addresses: check
`/leads` filtered by the method that found them. If complaints are rising, the
copy or the targeting is wrong, and no amount of pacing fixes that.

### The generator is failing

`/health` shows the outcome breakdown. Distinguish the three cases before
touching anything:

- **Lots of `no_proof`.** Since severity 0 exists this should be rare, and a run
  of it now means the generator cannot reach sites rather than that sites are
  healthy. Historically: §15.4, most sites are clean or
  merely imperfect, and this is expected to be the majority outcome. If it is
  *not* the majority, the generator is being too generous about what counts as a
  finding, which is the worse failure.
- **Lots of `generator_failed`.** Three failed attempts or two hours pending. If
  it is *every* lead, check that `PROBE_HMAC_SECRET` matches the Firebase secret
  on the exit1 side: a mismatch is a 401 on every call. Otherwise read the
  generator's own logs (`firebase functions:log --only probeGenerate`); probe
  only sees status codes.
- **Everything pending.** The generator is accepting requests and never
  finishing. The two-hour elapsed-time budget will release the slots.

A `generator_failed` whose error starts `copy lint failed:` is different: the
generator produced a finding whose copy breaks §9.2. The violation codes are on
`proofs.error`, and the fix is in the generator, not in probe.

### A lead dropped and you want to know why

`/leads` filtered by `drop_reason`. The reason is written once and never
overwritten, so the first cause of death is the one you see.

| `drop_reason`              | Meaning                                       |
|----------------------------|-----------------------------------------------|
| `jurisdiction_blocked`     | Country is on the blocklist                   |
| `no_match`                 | Fits no campaign                              |
| `suppressed`               | Address already opted out                     |
| `contacted_other_campaign` | Address already received a probe email        |
| `no_contact`               | The cascade found nothing                     |
| `no_proof`                 | Generator could not measure the site at all   |
| `generator_failed`         | 3 failed attempts, 2 hours pending, or a lint failure |

`contacted_other_campaign` is the one to watch. After a month, count it as a
share of matched leads. Below about 5% the contact-once policy is free and
stays. Above about 25% there is a genuine decision to make, and it gets made
with that number rather than a guess.

A lead sitting in `matched` with no drop reason is one whose contact cascade
threw. `resolve` picks those up again on its next run, so it should clear itself.

### A GDPR erasure request

```bash
pnpm --filter @probe/worker cli hash  founder@example.com    # just the hash
pnpm --filter @probe/worker cli erase founder@example.com    # shows what it would do
pnpm --filter @probe/worker cli erase founder@example.com --yes
```

`erase` removes the contact rows, the sends and their events for that hash,
across every campaign. The suppression row itself **stays**: deleting it would
make the address contactable again, which is the opposite of what the person
asked for, and it holds only a peppered hash. Explain that in the reply.

### Someone replied and is annoyed

They are already suppressed: any reply inserts a suppression before anything
else happens. Answer them as a person, not as a system. Do not offer to resend
anything.

---

## 8. Things that are supposed to be inconvenient

Listed here so nobody "fixes" them.

- **Campaigns are born paused, and seeding never unpauses them.**
- **Warmup must be started by hand**, and until it is, the cap is 0.
- **`PROBE_SEND_ENABLED` defaults to false** and is checked before every send,
  not once at boot.
- **The worker refuses to boot live with a broken send configuration.** A
  localhost base url or a missing webhook secret is a failed unit, not a warning.
- **`DK` missing from the blocklist refuses to start the process.** Not a
  warning. Denmark is not a configuration option.
- **The copy lint blocks approval**, including on a placeholder postal address.
  A generator tweak that quietly turns informative into salesy is exactly what
  it exists to catch.
- **`SNS_ALLOWED_TOPIC_ARNS` empty means nobody**, not everybody.
- **`CF_ACCESS_REQUIRED` unset means the gate is ON.** It has to be set to the
  literal `false` to turn it off.
- **There is no resubscribe path.** Suppression is permanent by design.
- **`PROBE_HASH_PEPPER` never rotates.**
- **A stuck send is never re-sent automatically.** Re-approval is a human act.
