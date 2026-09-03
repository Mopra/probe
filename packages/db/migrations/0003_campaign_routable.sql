-- 0003_campaign_routable: a campaign can be off the routing rota without being
-- deleted.
--
-- `paused` gates SENDING and deliberately does not gate routing: pausing is how
-- you stop mail going out while the pipeline keeps filling the queue behind it,
-- and PLAN.md §8.2 is explicit that a paused campaign is still a match
-- candidate.
--
-- That left no way to say the thing that was actually true of `day3`: its
-- generator does not exist yet. day3.app has no /api/probe/generate, so the URL
-- in probe.toml returns a Vercel 404 page. Matching is round robin, so half of
-- every intake was routed to it: 29 of the first 61 leads, and each one that
-- reached a generator call spent three attempts collecting 404s before dying.
-- Nothing in /health said so, because those leads showed as `pending`, which
-- reads like work in progress rather than a URL that has never existed.
--
-- `routable` is that missing state. Off means "do not send leads here at all",
-- and it belongs on the campaign rather than in code because it is exactly the
-- kind of thing that flips the day the endpoint ships.
--
-- Default true: every existing campaign keeps routing. The seed sets it from
-- probe.toml like any other static field.
alter table campaigns add column if not exists routable boolean not null default true;

comment on column campaigns.routable is
  'Whether matching may route leads here. Distinct from paused, which gates sending only.';
