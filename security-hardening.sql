-- ═══════════════════════════════════════════════════════════════════════════
-- Latvian Thumbs — security hardening
-- ═══════════════════════════════════════════════════════════════════════════
-- Everything here is enforced in Postgres, NOT in the page. That is the whole
-- point: the chat's security does not depend on where index.html is hosted, so
-- moving off github.io to any other domain changes nothing about who can read
-- the room. The only domain-coupled setting lives in the Supabase dashboard
-- (Authentication → URL Configuration) and is called out at the bottom.
--
-- Apply with:  cd ~/lendpaper-engine && ./venv/bin/python run_sql.py security-hardening.sql
-- Safe to re-run.


-- ───────────────────────────────────────────────────────────────────────────
-- 1. CRITICAL — close the anonymous message-injection hole
-- ───────────────────────────────────────────────────────────────────────────
-- ff_post_bot() and the ff_bot_* functions are SECURITY DEFINER and insert
-- straight into ff_chat_messages with NO membership check — that is by design,
-- they are called by pg_cron as `postgres`.
--
-- But `revoke all ... from public` in schema.sql did NOT actually lock them
-- down. Supabase grants EXECUTE on new public-schema functions to `anon` and
-- `authenticated` via ALTER DEFAULT PRIVILEGES, and those are separate grants
-- that a PUBLIC-only revoke does not touch. Verified live: proacl showed
-- `anon=X/postgres` on every one of them.
--
-- Net effect before this fix: anyone on the internet holding the publishable
-- key (it is in this repo, and on lendpaper.com) could POST
-- /rest/v1/rpc/ff_post_bot and inject a message into the league room under any
-- screen name they liked — including a member's name or "OnlineHost".
-- No sign-in, no allowlist, nothing.
--
-- Revoke from the roles PostgREST actually authenticates as. pg_cron runs the
-- schedules as `postgres`, which owns the functions, so the bots keep working.
revoke execute on function public.ff_post_bot(text, text, text) from anon, authenticated, public;
revoke execute on function public.ff_bot_matt()     from anon, authenticated, public;
revoke execute on function public.ff_bot_joe()      from anon, authenticated, public;
revoke execute on function public.ff_bot_lars()     from anon, authenticated, public;
revoke execute on function public.ff_bot_reminder() from anon, authenticated, public;

-- The membership/admin predicates are harmless for a logged-out caller (they
-- read auth.jwt(), which is empty, and return false) but there is no reason to
-- expose them as public RPC endpoints. `authenticated` still needs them — the
-- page calls is_ff_member() on boot.
revoke execute on function public.is_ff_member() from anon, public;
revoke execute on function public.is_ff_admin() from anon, public;
grant  execute on function public.is_ff_member() to authenticated;
grant  execute on function public.is_ff_admin() to authenticated;

-- ff_8ball is not deployed yet (see §6). Guard the grants so this file stays
-- correct whenever it does get created.
do $$
begin
  if to_regprocedure('public.ff_8ball(text)') is not null then
    execute 'revoke execute on function public.ff_8ball(text) from anon, public';
    execute 'grant  execute on function public.ff_8ball(text) to authenticated';
  end if;
end $$;

-- Stop the same thing happening to the NEXT function somebody adds: default
-- privileges are what re-granted `anon` in the first place.
alter default privileges in schema public revoke execute on functions from anon;


-- ───────────────────────────────────────────────────────────────────────────
-- 2. Stop members impersonating each other
-- ───────────────────────────────────────────────────────────────────────────
-- The old insert policy pinned user_id to auth.uid() but let the client send
-- ANY screen_name. Since screen_name is what the room actually renders, one
-- line in a browser console let any member post as any other member — or as a
-- bot, since `bot` was unconstrained too.
--
-- Now screen_name must equal the name this account locked in, `bot` must be
-- false, and color must be a plain 6-digit hex (it is interpolated into a
-- style="color:…" attribute client-side, so free text there is a CSS-injection
-- vector even though the HTML escaping holds).
drop policy if exists "ff_chat_member_insert" on public.ff_chat_messages;
create policy "ff_chat_member_insert" on public.ff_chat_messages
  for insert to authenticated
  with check (
    public.is_ff_member()
    and user_id = auth.uid()
    and bot = false
    and screen_name = (
      select p.screen_name from public.ff_chat_profiles p where p.user_id = auth.uid()
    )
    and (color is null or color ~ '^#[0-9a-fA-F]{6}$')
    and char_length(body) between 1 and 2000
    and char_length(room) between 1 and 80
  );

-- Same treatment for the profile row itself.
drop policy if exists "ff_chat_profile_insert_own" on public.ff_chat_profiles;
create policy "ff_chat_profile_insert_own" on public.ff_chat_profiles
  for insert to authenticated with check (
    user_id = auth.uid()
    and public.is_ff_member()
    and char_length(screen_name) between 1 and 40
    and (color is null or color ~ '^#[0-9a-fA-F]{6}$')
  );

-- There is deliberately still no UPDATE or DELETE policy on ff_chat_messages
-- or ff_chat_profiles: nobody can rewrite or erase league history, and nobody
-- can change a locked screen name.


-- ───────────────────────────────────────────────────────────────────────────
-- 3. Make the realtime channel private
-- ───────────────────────────────────────────────────────────────────────────
-- Message CONTENT was never exposed here — postgres_changes events are filtered
-- per-subscriber against the RLS in §2, so a non-member socket receives nothing.
--
-- Presence was. The page joined `ff-room-league` as a PUBLIC channel, and a
-- public channel skips realtime authorization entirely: anyone with the
-- publishable key could join the topic and watch the presence roster — every
-- member's screen name, colour, user id, and who is typing — plus announce fake
-- members into everyone's room. These policies + `private: true` in index.html
-- close that.
--
-- Scoped to `ff-room-*` topics only, so nothing else in the project changes.
-- (realtime.messages already had RLS on with zero policies, i.e. every private
-- channel was denied; this only ever adds access for league members.)
drop policy if exists "ff_realtime_member_read"  on realtime.messages;
create policy "ff_realtime_member_read" on realtime.messages
  for select to authenticated
  using ( realtime.topic() like 'ff-room-%' and public.is_ff_member() );

drop policy if exists "ff_realtime_member_write" on realtime.messages;
create policy "ff_realtime_member_write" on realtime.messages
  for insert to authenticated
  with check ( realtime.topic() like 'ff-room-%' and public.is_ff_member() );


-- ───────────────────────────────────────────────────────────────────────────
-- 4. Take the video-call room name out of the public repo
-- ───────────────────────────────────────────────────────────────────────────
-- meet.jit.si rooms are open to anyone who knows the name, and the name was
-- hardcoded in index.html — which is a public GitHub repo. Anyone reading the
-- source could sit in the league's video call. That was the one place where
-- "hackers can listen in" was literally true.
--
-- The slug now lives here, readable only by allowlisted members, and can be
-- rotated any time without touching the site.
create table if not exists public.ff_chat_settings (
  key        text primary key,
  value      text not null,
  updated_at timestamptz not null default now()
);
alter table public.ff_chat_settings enable row level security;

drop policy if exists "ff_settings_member_read" on public.ff_chat_settings;
create policy "ff_settings_member_read" on public.ff_chat_settings
  for select to authenticated using ( public.is_ff_member() );

drop policy if exists "ff_settings_admin_write" on public.ff_chat_settings;
create policy "ff_settings_admin_write" on public.ff_chat_settings
  for all to authenticated using ( public.is_ff_admin() ) with check ( public.is_ff_admin() );

-- Random, never committed anywhere. Re-run the update below to rotate the room
-- (e.g. if someone leaves the league):
--   update public.ff_chat_settings
--      set value = 'LatvianThumbs-' || encode(gen_random_bytes(12),'hex'),
--          updated_at = now()
--    where key = 'video_room';
insert into public.ff_chat_settings (key, value)
values ('video_room', 'LatvianThumbs-' || encode(gen_random_bytes(12),'hex'))
on conflict (key) do nothing;


-- ───────────────────────────────────────────────────────────────────────────
-- 5. Basic flood protection
-- ───────────────────────────────────────────────────────────────────────────
-- A member cannot read anything they shouldn't, but nothing stopped one from
-- scripting 10,000 inserts and burning the project's quota. 30 messages per
-- rolling minute per account is far above human chat rate and well below abuse.
create or replace function public.ff_rate_ok()
returns boolean language sql stable security definer set search_path = public as $$
  select count(*) < 30
    from public.ff_chat_messages
   where user_id = auth.uid()
     and created_at > now() - interval '1 minute';
$$;
-- Must stay executable by `authenticated`: the policy below evaluates it as the
-- calling role, so revoking it there blocks every member from posting at all.
-- It only ever counts the caller's own rows via auth.uid(), so it leaks nothing.
revoke execute on function public.ff_rate_ok() from anon, public;
grant  execute on function public.ff_rate_ok() to authenticated;

drop policy if exists "ff_chat_rate_limit" on public.ff_chat_messages;
create policy "ff_chat_rate_limit" on public.ff_chat_messages
  as restrictive for insert to authenticated
  with check ( public.ff_rate_ok() );


-- ───────────────────────────────────────────────────────────────────────────
-- 6. Schema drift — NOT applied here, flagged only
-- ───────────────────────────────────────────────────────────────────────────
-- Verified against the live database on 2026-08-01: public.ff_chat_contacts and
-- public.ff_8ball(text) do not exist, even though schema.sql defines them and
-- index.html calls both. Both failures are swallowed client-side, so "People →
-- Add My Contact Info" and "/8ball" silently do nothing today. That is a
-- feature bug, not a security one, so it is deliberately left alone here —
-- re-running schema.sql creates them, and §1's grants then apply to ff_8ball.


-- ───────────────────────────────────────────────────────────────────────────
-- 7. The only setting that IS tied to the domain
-- ───────────────────────────────────────────────────────────────────────────
-- Nothing above cares what host serves index.html. The one thing that does is
-- OAuth: Supabase → Authentication → URL Configuration.
--
-- When moving to a new domain:
--   * add the new origin to Redirect URLs, e.g. https://newdomain.com/**
--   * remove the old one once the move is done
--   * never use a bare wildcard (`**`, `https://**`, or a scheme-only entry) —
--     that lets any site on the internet receive a real OAuth code for this
--     project and become a signed-in user
--
-- A wrong entry here breaks sign-in; it cannot expose existing messages,
-- because reads are gated by is_ff_member() in Postgres regardless of origin.


-- ───────────────────────────────────────────────────────────────────────────
-- verify
-- ───────────────────────────────────────────────────────────────────────────
-- select proname, array_to_string(proacl,' | ')
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--  where n.nspname = 'public' and proname like 'ff_%';        -- no anon=X
-- select policyname, cmd from pg_policies
--  where schemaname = 'public' and tablename like 'ff_%';
