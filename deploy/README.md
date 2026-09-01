# deploy

`probe-worker.service` is the systemd unit for `apps/worker` on the VPS. See
`docs/RUNBOOK.md` §5.3 for the install steps, §6 for going live, and §7 for the
kill switches.

Two things about the unit are worth knowing before you edit it:

- `StartLimitBurst` and `StartLimitIntervalSec` are in `[Unit]`. They were in
  `[Service]`, where modern systemd ignores them with a warning, so the
  crash-loop protection the comment described was not actually in effect.
- On boot, when `PROBE_SEND_ENABLED=true`, the worker runs the send preflight and
  **refuses to start** if the Day3 key, the webhook secret, the public base url
  or the postal address are unusable. A failed unit there is the intended
  outcome, not a bug to work around: every fault it catches produces mail that
  looks fine in the log and is broken in the recipient's inbox. Run
  `pnpm --filter @probe/worker cli preflight` to see the same list without
  restarting anything.

`/opt/probe/.env` must be mode 600 and owned by the `probe` user. It holds
`DAY3_API_KEY` and `PROBE_HASH_PEPPER`, and the pepper cannot be rotated if it
leaks: rotating it orphans every suppression row, which makes every person who
opted out contactable again.

`apps/web` deploys to Vercel from the repo root with `apps/web` as the project
root directory. It has no artifact here because Vercel owns that config. Three
things there are not optional:

- The Cloudflare Access bypass list in RUNBOOK §5.2, which keeps `/u`, `/c`,
  `/data` and `/hooks/*` public.
- `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD`. The middleware verifies
  Cloudflare's signed assertion rather than trusting its identity header, and the
  AUD tag is what ties a token to *this* Access application: every application in
  a Cloudflare team is signed by the same keys.
- Vercel Deployment Protection, so the origin is not reachable at its
  `*.vercel.app` hostname without Cloudflare in front of it.

probe holds no AWS credentials. Day3 owns the SES account (PLAN.md §5.1), so
there is nothing to deploy for sending beyond the API key and the webhook
endpoint described in RUNBOOK §2.
