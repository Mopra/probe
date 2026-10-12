-- 0004_contact_screen: each contact is screened for plausibility once, and the
-- verdict is kept.
--
-- probe was paused at a 15% hard bounce rate: 5 of the first 33 sends, every
-- one of them an address scraped off a product site. Three of the five were
-- visibly not a person's inbox ('562ae1d6@ssh.ephemerals.dev',
-- 'helpfaqsupport@...', 'partners@...'), and the rules in junkReason now catch
-- that shape. The other two were 'hello@' on small products, which look fine
-- to any rule, so a second stage asks an LLM whether the address is plausibly a
-- founder's inbox. PLAN.md forbids SMTP RCPT probing, and this is not that: it
-- reads the address and the product, and never talks to the recipient's server.
--
-- The verdict lives on the contact because it is a judgement about the address
-- on that lead, and because asking twice costs money and can answer
-- differently. Approval and dispatch both read it; only a null runs the screen.
--
-- All three columns are nullable and default to null: every existing contact
-- is unscreened, which is exactly what is true of it.
alter table contacts add column if not exists screen_verdict text;
alter table contacts add column if not exists screen_reason text;
alter table contacts add column if not exists screened_at timestamptz;

comment on column contacts.screen_verdict is
  'person | shared | junk. Only person is sent to. Null means not screened yet.';
comment on column contacts.screen_reason is
  'Why, prefixed with the stage that decided: rules: ... or llm <confidence>: ...';
comment on column contacts.screened_at is
  'When the verdict was written. Null with screen_verdict.';
