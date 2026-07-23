-- ff_chat — invite-only league chat room (Google/Microsoft OAuth + email allowlist)
-- Run via: cd ~/lendpaper-engine && ./venv/bin/python run_sql.py supabase/ff_chat.sql
--
-- Access model (see markdowns plan / CLAUDE.md LEN-285 auth rules):
--   * Identity = verified OAuth email (Google or Microsoft). No magic links.
--   * Only emails present in ff_chat_allowlist can read or post. The list itself
--     is never exposed to the client — membership is checked through the
--     SECURITY DEFINER function is_ff_member() (same shape as
--     anon_quote_recent_count() in anon_shared_quotes.sql).
--   * Realtime postgres_changes inherits the RLS below, so non-members receive
--     nothing — the room is genuinely private, not just unlisted.

-- ── allowlist ────────────────────────────────────────────────────────────────
create table if not exists public.ff_chat_allowlist (
  email     text primary key,
  label     text,                                   -- optional display note ("Mike - QB1")
  added_at  timestamptz not null default now()
);
alter table public.ff_chat_allowlist enable row level security;
-- Intentionally NO policies: only the service role and the SECURITY DEFINER
-- function below may read this table. The client can never enumerate the league.

-- ── messages ─────────────────────────────────────────────────────────────────
create table if not exists public.ff_chat_messages (
  id           bigint generated always as identity primary key,
  room         text        not null default 'league',
  user_id      uuid        not null references auth.users(id) on delete cascade,
  screen_name  text        not null,
  body         text        not null,
  color        text,
  created_at   timestamptz not null default now()
);
create index if not exists ff_chat_room_time on public.ff_chat_messages (room, created_at);
alter table public.ff_chat_messages enable row level security;

-- ── membership check (bypasses allowlist RLS via SECURITY DEFINER) ────────────
create or replace function public.is_ff_member()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.ff_chat_allowlist a
    where lower(a.email) = lower(coalesce(auth.jwt() ->> 'email', ''))
  );
$$;
revoke all on function public.is_ff_member() from public;
grant execute on function public.is_ff_member() to authenticated;

-- ── RLS: allowlisted, signed-in members only ─────────────────────────────────
drop policy if exists "ff_chat_member_select" on public.ff_chat_messages;
create policy "ff_chat_member_select" on public.ff_chat_messages
  for select to authenticated
  using (public.is_ff_member());

drop policy if exists "ff_chat_member_insert" on public.ff_chat_messages;
create policy "ff_chat_member_insert" on public.ff_chat_messages
  for insert to authenticated
  with check (
    public.is_ff_member()
    and user_id = auth.uid()
    and char_length(body) between 1 and 2000
    and char_length(screen_name) between 1 and 40
    and char_length(room) between 1 and 80
  );

-- ── per-member profile: the screen name is chosen ONCE and then locked ───────
create table if not exists public.ff_chat_profiles (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  email       text,
  screen_name text not null,
  color       text,
  created_at  timestamptz not null default now()
);
-- one name per person, and no two members can share a name (case-insensitive)
create unique index if not exists ff_chat_profiles_name_ci
  on public.ff_chat_profiles (lower(screen_name));
alter table public.ff_chat_profiles enable row level security;

-- a member reads their own profile row...
drop policy if exists "ff_chat_profile_select_own" on public.ff_chat_profiles;
create policy "ff_chat_profile_select_own" on public.ff_chat_profiles
  for select to authenticated using (user_id = auth.uid());
-- ...and inserts it exactly once (as themselves, if a member). There is
-- deliberately NO update or delete policy, so once the screen name is set it can
-- never be changed — "everyone picks their screen name one time".
drop policy if exists "ff_chat_profile_insert_own" on public.ff_chat_profiles;
create policy "ff_chat_profile_insert_own" on public.ff_chat_profiles
  for insert to authenticated with check (
    user_id = auth.uid()
    and public.is_ff_member()
    and char_length(screen_name) between 1 and 40
  );

-- ── join requests: in-app "Request to Join" queue ─────────────────────────────
-- Replaces the manual "email me and I'll edit SQL" flow. A signed-in-but-not-
-- yet-allowlisted visitor can file one request (email comes from their verified
-- OAuth session, never a typed field — can't be spoofed). The commissioner
-- (ADMIN_EMAIL below) approves/denies from an in-app panel; approving inserts
-- straight into ff_chat_allowlist.
create table if not exists public.ff_chat_join_requests (
  id          bigint generated always as identity primary key,
  user_id     uuid references auth.users(id) on delete cascade,
  email       text not null,
  note        text,
  status      text not null default 'pending' check (status in ('pending','approved','denied')),
  created_at  timestamptz not null default now()
);
-- only one live pending request per email at a time (re-requesting is a no-op,
-- surfaced client-side as "already requested")
create unique index if not exists ff_chat_join_requests_email_ci
  on public.ff_chat_join_requests (lower(email)) where status = 'pending';
alter table public.ff_chat_join_requests enable row level security;

-- SECURITY DEFINER admin check — single commissioner, hardcoded on purpose
-- (simplest correct thing for a 12-person league; swap for an is_admin column
-- on ff_chat_allowlist if you ever need more than one admin).
create or replace function public.is_ff_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select lower(coalesce(auth.jwt() ->> 'email', '')) = 'stephengowa@gmail.com';
$$;
revoke all on function public.is_ff_admin() from public;
grant execute on function public.is_ff_admin() to authenticated;

drop policy if exists "ff_join_insert_own" on public.ff_chat_join_requests;
create policy "ff_join_insert_own" on public.ff_chat_join_requests
  for insert to authenticated with check (
    lower(email) = lower(coalesce(auth.jwt() ->> 'email',''))
    and (user_id is null or user_id = auth.uid())
    and char_length(coalesce(note,'')) <= 140
  );

drop policy if exists "ff_join_select_own_or_admin" on public.ff_chat_join_requests;
create policy "ff_join_select_own_or_admin" on public.ff_chat_join_requests
  for select to authenticated using (
    user_id = auth.uid()
    or lower(email) = lower(coalesce(auth.jwt() ->> 'email',''))
    or public.is_ff_admin()
  );

drop policy if exists "ff_join_update_admin" on public.ff_chat_join_requests;
create policy "ff_join_update_admin" on public.ff_chat_join_requests
  for update to authenticated using (public.is_ff_admin()) with check (public.is_ff_admin());

-- admin can add an approved requester straight to the allowlist from the app —
-- still no SELECT policy on ff_chat_allowlist, so the client can add but never
-- enumerate the roster.
drop policy if exists "ff_chat_allowlist_admin_insert" on public.ff_chat_allowlist;
create policy "ff_chat_allowlist_admin_insert" on public.ff_chat_allowlist
  for insert to authenticated with check (public.is_ff_admin());

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ff_chat_join_requests'
  ) then
    alter publication supabase_realtime add table public.ff_chat_join_requests;
  end if;
end $$;

-- ── /8ball command: posts the asker's question + an instant bot reply ─────────
-- SECURITY DEFINER so the reply can be inserted with no user_id (a real bot
-- row), same as ff_post_bot — but this always fires immediately, ignoring the
-- lull guard above, because it's a direct request, not a passive scheduled post.
create or replace function public.ff_8ball(p_question text)
returns void language plpgsql security definer set search_path = public as $$
declare answers text[]; ans text; asker text; asker_color text;
begin
  if not public.is_ff_member() then raise exception 'not a member'; end if;
  select screen_name, color into asker, asker_color from public.ff_chat_profiles where user_id = auth.uid();
  if asker is null then raise exception 'no profile yet'; end if;

  insert into public.ff_chat_messages (room, user_id, screen_name, body, color)
  values ('league', auth.uid(), asker, '/8ball ' || left(coalesce(p_question,''), 400), asker_color);

  answers := array[
    'It is certain.', 'Ask again after the waiver deadline.', 'Outlook not so good — bench him.',
    'Signs point to yes.', 'Very doubtful.', 'Reply hazy, try a trade.', 'Without a doubt.',
    'My sources say no — trade him NOW.', 'Yes — definitely start him.',
    'Concentrate and ask again next week.', 'You already know the answer, coward.',
    'Better not tell you — someone might cry.'
  ];
  ans := answers[1 + floor(random() * array_length(answers,1))::int];
  insert into public.ff_chat_messages (room, user_id, screen_name, body, color, bot)
  values ('league', null, 'Magic 8-Ball', ans, '#4a148c', true);
end $$;
revoke all on function public.ff_8ball(text) from public;
grant execute on function public.ff_8ball(text) to authenticated;

-- ── per-member contact info: freely editable, separate from the locked profile ─
-- Deliberately its OWN table, not a column on ff_chat_profiles — that table's
-- screen_name is permanently locked (LEN one-time-name rule) and must never get
-- a broad "update your own row" policy, since that would let someone change
-- their locked name/color too. Contact info is fine to edit anytime.
create table if not exists public.ff_chat_contacts (
  user_id     uuid primary key references auth.users(id) on delete cascade,
  contact     text,
  updated_at  timestamptz not null default now()
);
alter table public.ff_chat_contacts enable row level security;

drop policy if exists "ff_contacts_select_members" on public.ff_chat_contacts;
create policy "ff_contacts_select_members" on public.ff_chat_contacts
  for select to authenticated using (public.is_ff_member());

drop policy if exists "ff_contacts_insert_own" on public.ff_chat_contacts;
create policy "ff_contacts_insert_own" on public.ff_chat_contacts
  for insert to authenticated with check (
    user_id = auth.uid() and public.is_ff_member() and char_length(coalesce(contact,'')) <= 200
  );

drop policy if exists "ff_contacts_update_own" on public.ff_chat_contacts;
create policy "ff_contacts_update_own" on public.ff_chat_contacts
  for update to authenticated using (user_id = auth.uid())
  with check (user_id = auth.uid() and char_length(coalesce(contact,'')) <= 200);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ff_chat_contacts'
  ) then
    alter publication supabase_realtime add table public.ff_chat_contacts;
  end if;
end $$;

-- ── realtime CDC (idempotent add) ────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'ff_chat_messages'
  ) then
    alter publication supabase_realtime add table public.ff_chat_messages;
  end if;
end $$;

-- ── daily bots (pg_cron) ─────────────────────────────────────────────────────
-- Fake "members" who post on a schedule. Rows have no auth user_id and bot=true.
create extension if not exists pg_cron;

alter table public.ff_chat_messages alter column user_id drop not null;
alter table public.ff_chat_messages add column if not exists bot boolean not null default false;

-- shared poster (SECURITY DEFINER so cron can insert past RLS). Waits for a
-- LULL — skips posting if a real human has spoken in the last 2 hours, so the
-- scheduled jokes don't interrupt an active conversation. (The /8ball command
-- below inserts directly, bypassing this — an invoked reply should never wait.)
create or replace function public.ff_post_bot(p_name text, p_body text, p_color text default '#6a1b9a')
returns void language plpgsql security definer set search_path = public as $$
declare last_human timestamptz;
begin
  select max(created_at) into last_human from public.ff_chat_messages where room = 'league' and bot = false;
  if last_human is not null and now() - last_human < interval '2 hours' then
    return;
  end if;
  insert into public.ff_chat_messages (room, user_id, screen_name, body, color, bot)
  values ('league', null, p_name, p_body, coalesce(p_color, '#6a1b9a'), true);
end $$;
revoke all on function public.ff_post_bot(text, text, text) from public;

-- Matt Jackson — a poem about missing a testicle, EVERY OTHER day
create or replace function public.ff_bot_matt() returns void
language plpgsql security definer set search_path = public as $fn$
declare lines text[]; i int;
begin
  if (extract(doy from now())::int % 2) <> 0 then return; end if;   -- every other day
  lines := array[
    $p$Ode to Lefty: once we were two, side by side / now it's just me, riding solo with pride / friend, you were taken too soon from the crew / but hey — more legroom. Draft a back or two. 🥚$p$,
    $p$Roses are red, my anatomy's askew / I'm down one testicle but up on you / start your studs, sit your duds, hear my plea / the One-Balled Oracle sees your loss early. 🥚$p$,
    $p$They call me Uno. They call me Solo / one cannonball left in the holster, yo / my waiver claims land like a phantom limb / lopsided, legendary, and still gonna win. 🥚$p$
  ];
  i := (extract(doy from now())::int % array_length(lines, 1)) + 1;
  perform public.ff_post_bot('Matt Jackson', lines[i], '#8e24aa');
end $fn$;

-- Joe Cohen — asks the same thing once a day
create or replace function public.ff_bot_joe() returns void
language sql security definer set search_path = public as $$
  select public.ff_post_bot('Joe Cohen', $b$what's up guys$b$, '#1565c0');
$$;

-- Lars — cracks a joke in German once a day (with a tiny translation)
create or replace function public.ff_bot_lars() returns void
language plpgsql security definer set search_path = public as $fn$
declare lines text[]; i int;
begin
  lines := array[
    $j$Warum können Bäume keine Fantasy-Liga gewinnen? Weil sie nur BLÄTTER lesen. 🌳 (…they only ever read the leaves / waiver wire.)$j$,
    $j$Was sagt der Kicker vor dem Spiel? "Tor oder nicht Tor — das ist hier die Frage." ⚽ (Goal or not goal, that is the question.)$j$,
    $j$Mein Team ist wie die Autobahn: kein Limit... und trotzdem stehe ich im Stau. 🚗 (No speed limit, yet somehow still stuck in traffic.)$j$
  ];
  i := (extract(doy from now())::int % array_length(lines, 1)) + 1;
  perform public.ff_post_bot('Lars', lines[i], '#00695c');
end $fn$;

-- Daily nudge: post here, not in WhatsApp
create or replace function public.ff_bot_reminder() returns void
language plpgsql security definer set search_path = public as $fn$
declare lines text[]; i int;
begin
  lines := array[
    $r$📣 Reminder: post it HERE, not in WhatsApp. This is the yard now. 🏈$r$,
    $r$📣 Friendly nudge from your Online Host — keep the trash talk in the Lobby, not the WhatsApp.$r$,
    $r$📣 Stop clogging the WhatsApp, degenerates. The banter lives HERE. 🍆$r$
  ];
  i := (extract(doy from now())::int % array_length(lines, 1)) + 1;
  perform public.ff_post_bot('OnlineHost', lines[i], '#008000');
end $fn$;

-- schedules (UTC; idempotent — re-running updates the job by name)
select cron.schedule('ff-bot-matt',   '0 14 * * *',  'select public.ff_bot_matt()');
select cron.schedule('ff-bot-joe',    '30 15 * * *', 'select public.ff_bot_joe()');
select cron.schedule('ff-bot-lars',   '0 18 * * *',  'select public.ff_bot_lars()');
select cron.schedule('ff-bot-remind', '0 21 * * *',  'select public.ff_bot_reminder()');

-- ── seed the league roster ───────────────────────────────────────────────────
-- Stored lowercase (is_ff_member() lower()s both sides, so case never matters,
-- and lowercase avoids case-variant duplicate PK rows). Re-run this file after
-- any roster change; existing rows are left untouched.
insert into public.ff_chat_allowlist (email, label) values
  ('matthew.e.dorfman@gmail.com', 'Matthew Dorfman'),
  ('jfcamacho83@gmail.com',       'J Camacho'),
  ('michael.j.camacho@gmail.com', 'Michael Camacho'),
  ('rosenhjp@gmail.com',          'Rosen'),
  ('stephengowa@gmail.com',       'Stephen'),
  ('anthony.velli@gmail.com',     'Anthony Velli'),
  ('jonathanmootz@gmail.com',     'Jonathan Mootz'),
  ('joseph.pepe@gmail.com',       'Joseph Pepe'),
  ('matthewsierra@gmail.com',     'Matthew Sierra'),
  ('mr.economou@gmail.com',       'Economou'),
  ('tedmootz@gmail.com',          'Ted Mootz'),
  ('teddylj@gmail.com',           'Teddy')
on conflict (email) do nothing;

-- verify: select count(*) from public.ff_chat_messages;
--         select email, label from public.ff_chat_allowlist order by added_at;
