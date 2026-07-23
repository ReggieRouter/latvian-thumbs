# Latvian Thumbs — league chat

A self-contained, invite-only AOL-style chat room. Static site — just `index.html`
+ `auth-callback.html`. No build step. Deployed on GitHub Pages.

## One-time setup
1. **Enable GitHub Pages:** repo Settings → Pages → Source: *Deploy from a branch* →
   Branch: `main` / `/ (root)` → Save. The site publishes at
   `https://<user>.github.io/<repo>/`.
2. **Run the database once:** open Supabase → SQL Editor → paste `schema.sql` → Run.
3. **Allow the domain for sign-in:** Supabase → Authentication → URL Configuration →
   add your Pages URL (e.g. `https://<user>.github.io/<repo>/`) to both **Site URL**
   and **Redirect URLs** (add `https://<user>.github.io/<repo>/**`).

That's it — share the Pages URL and invited members sign in with Google/Microsoft.

## Roster
Edit the `insert into public.ff_chat_allowlist ...` block in `schema.sql` and re-run.
