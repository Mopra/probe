# probe channels beyond email

Ideas for delivering a finding somewhere other than an inbox. Nothing here is
built. `PLAN.md` is still the specification and wins any argument with this
file; §14 there is the original sketch of a public reply channel and this file
is the expanded version of it, reordered around a number §14 did not have.

## The number that reorders §14

From `cli health` on 2026-09-07, drop reasons as a share of matched leads:

```
no_contact                 177   70.2%
no_proof                    17    6.7%
jurisdiction_blocked         5    1.9% of swept
```

§14 argued for a public channel mainly because it recovers leads the
jurisdiction gate blocks. That argument is worth 5 leads and can be retired.
The real case is `no_contact`: 177 leads where a product was matched, a
generator could probably measure it, and there is no address to send to. That
is 70% of everything probe matches, and every channel below is judged first on
whether it reaches that pool.

The second number that matters is that no channel raises output while the
warmup cap is the binding constraint. On the day this was written there were 56
ready proofs, 0 awaiting approval and a cap of 10/day. Adding a channel to that
picture adds queue depth, not sends. Build these when the cap is not the limit.

## Prerequisite for all of them: split the generator payload

`GeneratorReady` in `docs/CONTRACTS.md` returns an email: `subject`, `html`,
`text`. Every channel below needs the same finding rendered differently, so the
generator should return the finding and let probe render the message:

```
{ severity, headline, observed, expected, fix, evidence_url, meta }
```

Email rendering then lives in probe, next to the HN and GitHub renderers. The
copy lint splits the same way: footer, unsubscribe and postal address are
email-only rules, and the §9.2 copy rules apply to every channel.

Do this before the second channel exists, not after. It is a small change now
and a migration later.

Data model, as §14 already noted: a `channel` column on `sends` defaulting to
`'email'`, with the email-specific columns nullable. `sends_email_hash_uniq` is
the contact-once index and it is email-shaped, so a public channel needs its own
uniqueness key, probably `(channel, lead_id)`. Contact-once carries over to
every channel and it should stay a database constraint rather than a check in
application code, for the same reason it is one today.

---

## 1. Show HN thread reply

**Status: intended. First one to build.**

A reply in the lead's own Show HN thread carrying the same finding. Reaches the
`no_contact` pool almost perfectly, because `show_hn` is the only enabled source
so nearly all 177 have a thread. Show HN is invited feedback, so no electronic
mail law applies and no address is needed.

Ground rules, from §14 and still right:

- Only in the lead's own launch thread. Never cold-posted anywhere else.
- One comment per lead, ever.
- Same severity bar. Affiliation disclosed in the first line. Zero asks.
- Never boilerplate. See the phrasing section below.
- `auto_approve` stays off for this channel whatever `probe.toml` says for
  email. A wrong email is read by one skeptic; a wrong HN comment is permanent,
  attributed and read by a crowd looking for exactly that.

Cost: HN has no write API, so this is an authenticated session and a strict
self-imposed rate limit. One template repeated across three threads gets the
account flagged and burns the channel for good.

## 2. GitHub issue on the lead's own repo

**Status: saved. Build after HN proves the copy.**

An issue is the sanctioned place to report that something is broken, which
means the consent question that shapes the whole email pipeline simply does not
arise. It also has a real API, unlike HN, so rate limiting, idempotency and
retry are ordinary engineering rather than browser automation.

The format is better than email for this content: repro steps, response
headers, a curl one-liner the maintainer runs in five seconds.

What it needs: repo discovery in the resolve cascade, alongside the existing
contact hunt in `apps/worker/src/contact/`. Same shape as that cascade. The HN
post text, the site footer, `package.json`, the README.

Constraint: only works for leads with a public repo, so it complements the HN
channel rather than replacing it.

## 3. GitHub as an intake source

**Status: saved. Possibly better value than treating GitHub as a channel.**

New repos with a live demo URL, first releases, "Show your work" discussions.
This is lead supply feeding the pipeline that already works, instead of a second
sender to maintain. It also widens intake past the single enabled source, which
is a standing weakness: 11 of 12 sources are off.

**Do not mine commit author emails from git history.** GitHub's terms prohibit
using account information for unsolicited email. It is the obvious next thought
once a repo is in hand, and it trades a legal position probe was carefully built
to hold for a shortcut on the `no_contact` number. The repo is a channel, not an
address book.

## 4. A pull request that fixes the finding

**Status: saved. Probably not doing it. High effort, no scale.**

For a severity-1 with a one-line fix on a public repo, a PR that fixes the
actual defect is the highest-converting artifact in this document. It is also
hand-authored, unbatchable and slow.

If it ever happens it is a manual escalation off `/queue` rather than a pipeline
stage: a human picks a handful a month from findings that are already approved.
Automating it is the version to avoid. An automated PR against a stranger's repo
is worse than an automated issue, because it asks for review time rather than
attention.

## 5. Reddit, by private message only

**Status: saved. Not doing it yet. The PM framing is what makes it arguable.**

Public commenting on Reddit is not worth the risk: per-subreddit self-promo
policies vary, shadowbans are invisible so there is no feedback signal, and a
low-karma account posting findings reads as astroturf regardless of quality.

PMs are a different proposition. Find posts where someone is promoting their own
product, run that product through the normal pipeline, and send the finding as a
direct message. It reaches `no_contact` leads, and a post promoting a product is
at least adjacent to an invitation to look at it.

The honest risks, which are why this is saved rather than planned:

- Reddit's content policy treats unsolicited PMs as spam when they are
  promotional, and the finding is promotional in effect however it is worded.
  Enforcement is account suspension, and it arrives without warning.
- A PM has no unsubscribe and no audit trail on our side, so the §9 protections
  that make the email channel defensible do not transfer. Suppression would have
  to be tracked by Reddit handle, which is a new identity space in the schema.
- Unlike a Show HN thread, the post being a promotion is inferred by us rather
  than declared by them. That is a weaker consent story than HN and a much
  weaker one than a GitHub issue.

If it gets built: subreddit allowlist, one PM per handle ever, no follow-up
after silence, and manual approval on every single one.

## Dropped: X

The premise is a finding a stranger can verify in thirty seconds. That does not
fit in a reply, and cut down to what does fit it becomes the template message
five rules exist to prevent. Not saved as a maybe. Dropped.

---

## Phrasing with a model, and the lint that makes it safe

The boilerplate problem is real: the same finding in the same words across three
threads is astroturfing and gets an account flagged. Generating each comment
with a model fixes that, and it introduces one sharp risk that has to be closed
mechanically rather than by prompt.

**The model may phrase facts. It may never add one.** Pass it the structured
finding and forbid new claims. Then lint the output against the finding: every
number, hostname, URL, status code and endpoint in the generated text must
appear in the proof. Anything else is a hallucinated fact heading for a public,
permanent, attributed comment, and no amount of prompt discipline substitutes
for the check. This is the same idea as the existing copy lint, but containment
rather than a phrase blacklist, and the current lint cannot express it. It
follows the payload split above: the lint needs the structured finding to check
against, which is exactly what the split produces.

Two smaller notes:

- HN reads LLM voice quickly and dislikes it. Target terse and technical, not
  helpful and thorough. Short. No preamble, no summary of what was just said.
- A human reads the first twenty regardless of how good the lint gets.

---

## The watchlist

Not a channel. A change to what the finding is, and probably a bigger lever than
anything above.

Today a lead is probed once, minutes after it is swept, and the finding is
whatever was wrong at that moment: a header, a TLS setting, a broken link. Any
scanner can produce that, which is the weakness. It does not demonstrate exit1.

exit1 is uptime monitoring, and its distinctive finding requires time rather
than a single request. Put every swept lead under an exit1 monitor for seven
days and the finding becomes what happened to their site during their launch
week: down eleven minutes on Tuesday while the thread was on the front page, an
endpoint that got slow under load, a certificate expiring in nine days.

Why it is better:

- It is the product doing its actual job on their actual site, not a scan.
- It converts `no_proof`. A site that is clean on Monday is a lead again if it
  goes down on Thursday, and 17 leads have been dropped as clean so far.
- The ask writes itself, because the monitor already exists: here is the report,
  it keeps running if you want it.
- Nothing about the email path changes. Same queue, same lint, same gate.

Costs, honestly:

- Every lead is delayed seven days, so the pipeline gets a long pole.
- exit1 has to accept programmatic monitor creation and teardown, and probe has
  to clean up monitors for leads that never convert.
- It is a real generator change, not a config change.
- Monitoring a stranger's site for a week without asking is a heavier thing than
  probing it once, even though both are public-surface requests. Worth thinking
  about before building, and worth a line in the data notice.
