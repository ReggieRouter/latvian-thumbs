# Latvian Thumbs — league chat

> **Writing chat content?** Read [CHAT_RULES.md](CHAT_RULES.md) first — topic
> budget, the dead-bit ban list, and the loop disruptors. It governs both the
> reactive bots and the pre-seeded day script.

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

## Inviting people
The **Invite League…** button has the usual copy-link / text / share buttons for
everyone. The commissioner (`is_ff_admin()`) also sees the live roster, with who
has signed in at least once and who hasn't, plus:

* **Email everyone who isn't in yet** — one BCC'd mail to just the stragglers.
* **Email the whole league** — one BCC'd mail to everybody.
* **Email** next to each name — a personalised one-to-one nudge.

All of it opens the commissioner's own mail app via `mailto:` — no mail server,
no API key, nothing to configure. Group sends are BCC so nobody sees anyone
else's address, and the roster is fetched through `ff_roster()`, which returns
nothing at all unless the caller is the commissioner.

## GIFs
The 🎬 GIF button ships with a built-in pack of ~420 hotlinked Tenor GIFs across
30 tags, so search and browse work with zero setup.

To upgrade it to full live Tenor search, grab a free key at
<https://developers.google.com/tenor/guides/quickstart> and paste it into
`TENOR_KEY` in `index.html`. The picker switches over automatically, and still
falls back to the built-in pack if Tenor is ever down or the key stops working.

> Note: the old `LIVDSRZULELA` demo key no longer works — Tenor retired it along
> with the v1 API, which is why the button used to only ever say "unavailable".
