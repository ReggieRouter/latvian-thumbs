# Latvian Thumbs — league chat

A self-contained, invite-only AOL-style chat room. Static site — just `index.html`
+ `auth-callback.html`. No build step. Deployed on GitHub Pages.

## One-time setup
1. **Enable GitHub Pages:** repo Settings → Pages → Source: *Deploy from a branch* →
   Branch: `main` / `/ (root)` → Save. The site publishes at
   `https://<user>.github.io/<repo>/`.
2. **Run the database once:** open Supabase → SQL Editor → paste `schema.sql` → Run,
   then `security-hardening.sql` → Run.
3. **Allow the domain for sign-in:** Supabase → Authentication → URL Configuration →
   add your Pages URL (e.g. `https://<user>.github.io/<repo>/`) to both **Site URL**
   and **Redirect URLs** (add `https://<user>.github.io/<repo>/**`). Scope it to the
   exact origin — never a bare `**`.

That's it — share the Pages URL and invited members sign in with Google/Microsoft.

## Roster
Add people from the app: sign in as the commissioner → **🔔 Requests** → Approve.
Members' email addresses are **never committed to this repo** — they live only in
the `ff_chat_allowlist` table. See the note at the bottom of `schema.sql`.

## Security
`security-hardening.sql` is the lockdown pass. Read its header before changing any
RLS policy, realtime channel, or function grant. Short version:

- Who can read the messages is decided by Postgres (`is_ff_member()`), not by the
  page. Verified: an anonymous visitor and a signed-in non-member each read **0**
  rows; a member reads all of them. **Moving to another domain does not change
  this** — the only host-dependent setting is the OAuth redirect list above, and
  getting it wrong breaks sign-in rather than exposing anything.
- The realtime channel must stay `private: true`. A public channel leaks the
  presence roster to anyone holding the publishable key.
- The Jitsi room name must stay in `ff_chat_settings` (members-only). Hardcoding it
  back into `index.html` publishes the video call to anyone reading this repo.
- Never `grant execute` on `ff_post_bot` / `ff_bot_*` to `anon` or `authenticated`.
  They insert messages with no membership check, on purpose, for pg_cron only.
