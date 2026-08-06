# Latvian Thumbs — chat content rules (LEN-1528)

**Read this before writing a single chat line, by any path.**

There are two ways messages get into `ff_chat_messages`, and the rules below
apply to BOTH. Getting this wrong in one path while fixing the other is what
happened on 2026-08-04 and is the whole reason this file exists.

| Path | What it is | Where the rules live |
|---|---|---|
| **Reactive bots** | `supabase/functions/ff-bot-reply` — a human posts, Claude answers in character | `INSTRUCTIONS` in `index.ts` |
| **Day script** | ~26-30 rows generated automatically every night and inserted with staggered `created_at`, so the room looks alive all day | **this file**, mirrored in `INSTRUCTIONS` in `supabase/functions/ff-daily-seed/index.ts` |

The day-script path is the one people actually read most days. It had no written
rules at all until 2026-08-04, which is how it drifted.

**As of 2026-08-04 (LEN-1528) the day script is automated** — `ff-daily-seed`
runs nightly at 3:00 AM ET via `pg_cron`, asks Claude for the day following the
rules below, validates the result, and inserts it. Nobody needs to hand-write a
batch anymore. If you're editing the rules, edit them in BOTH places: this file
and the `INSTRUCTIONS` constant in `ff-daily-seed/index.ts` — the function
doesn't read this file at runtime, it has its own copy.

> **Tell them apart in the DB — corrected 2026-08-06 (LEN-1593).** The old
> advice here said whole-second timestamps meant hand-written rows. **That is
> wrong and it cost a diagnosis.** `ff-daily-seed` computes `created_at` as
> `window_start + offset_min`, so *its* rows are whole-second too. Only
> `ff-bot-reply` inserts at real clock time and therefore has fractional
> seconds.
>
> The reliable test is **`ff_daily_seed_log`**: one row per ET date the seed
> actually wrote. Chat messages on a date with no matching log row came from
> somewhere else. Cross-check `ff_daily_seed_spend.calls` — content with no
> spend behind it was not generated.

> ⚠️ **Never hand-write and bulk-insert a day.** This is not a style
> preference. The nightly job skips any date that already has messages, so a
> hand-inserted day doesn't just break the rules — it silently switches the
> automation off for that date. On 2026-08-04 someone pre-filled Aug 5-7; the
> job then no-opped every night, spent nothing, logged nothing, and the chat
> quietly went back to the old loop until Steve noticed the repetition. If a day
> genuinely needs regenerating, invoke `ff-daily-seed` with `{"force": true}`.

---

## 0. League canon (settled facts)

These are decided. They live in `supabase/functions/_shared/canon.ts` and are
injected into both functions' prompts. **Do not restate them in chat and do not
change them.**

| Fact | Value |
|---|---|
| Draft | **Sunday, August 23rd 2026, 6:00 PM sharp** |
| Venue | McSorley's Old Ale House, NYC |
| Keeper lock deadline | August 17th 2026 |
| Dues | $75, cash at the draft |
| Commissioner | Steve Gowa (Chris signs off as "League Commissioner" as a bit) |
| Reigning champion | George Economou |
| Settled votes | 2QB **dead**; keeper-inflation review **passed** |

Announced in-chat 2026-07-27: *"RESULTS. Draft: McSorley's, Sunday Aug 23rd, 6
pm sharp."*

**Why this section exists (LEN-1593):** nothing pinned these, so each
generation re-derived them from recent history and they drifted — the time
slid from 6pm to 7pm between Aug 3 and Aug 6, and `ff-bot-reply` had
`DRAFT_NIGHT = '2026-08-27'` hardcoded, a Thursday matching nothing the room
ever said. If chat history contradicts this table, **the table wins.**

Never compute "the draft is in N days" into a message. It goes stale, it drifts,
and it isn't interesting.

---

## 1. What this chat is about

It is a group of lifelong friends talking. Fantasy football is the excuse they
know each other — **it is not the subject.** The subject is the world, their
lives, and each other.

A day that is mostly roster talk and league admin is a broken day. Target the
texture of a bar conversation: it wanders, it derails, someone brings up
something from their week, someone else makes it worse.

## 2. Topic budget (hard limit)

- **No more than 1 in 4 messages** may be about fantasy football, the draft,
  keepers, rosters, waivers, dues, payment, or league logistics.
- The other **3 in 4** are life and the world.
- Football that does appear should be reactive and specific (an actual thing
  that happened yesterday), never generic anticipation of the draft.

**Topic wheel — rotate, don't repeat within a week:**
work and bosses and commutes · kids, parents, spouses, in-laws · what they ate
and where · weather and heat · movies and TV and what's streaming · music and
concerts · the news of the day handled stupidly · travel and airports · a health
scare or a doctor visit · car trouble · home repair and contractors · money in
general (**not** league dues) · getting older · phones, apps, AI, tech
annoyances · sports that are not fantasy football · neighbors · pets · gossip
about people not in the room · 90s and AOL nostalgia · dumb hypotheticals and
would-you-rathers · petty grievances · food arguments (pizza, bagels, barbecue)

## 3. Loop disruptors

The failure mode is a handful of bits repeating forever. Treat what's already
been said as an **exclusion list, not a menu.**

### Dead-bit ban list

Each of these is funny about **once a week.** Cap: **at most one appearance per
40 messages**, and never twice in a row from the same member.

- dues, Venmo, who has or hasn't paid, chasing anyone for money
- George's ring / championship / any demand for an apology about it
- the draft date, the bar, the venue, RSVPs, who's coming
- "if Gowa's in I'm out"
- Gordon not understanding a rule, and Casey-Ann narrating that he doesn't
- Anthony Velli's "Day N" counter
- Michael Camacho's Starbucks / stolen wifi / masturbatory-lifestyle line
- Joe Camacho's "money is on the way"
- Matt Sierra's "book it, this is the year" sleeper-WR bit

### The other four

2. **Signature-tag throttle.** Catchphrases and sign-offs are garnish. At most
   one signature tag per turn (reactive) or per 10 messages (day script). A
   member's voice has to survive without their tagline.
3. **Mandatory new subject.** Every turn — and at least every 4th message in a
   day script — must raise something not already present: a thing that happened
   to them, a thing they saw, an opinion nobody asked for.
4. **Build, don't restate.** Every message adds a NEW fact, opinion, admission,
   or story. A line that only re-labels the previous one ("classic X", "X doing
   X things") is a wasted slot. Rewrite it.
5. **No stock openers.** If a line would have worked verbatim yesterday, it's
   wrong.

## 4. Turn-to-turn build

A day script is a *conversation*, not 30 independent one-liners. Threads should
start, get picked up by two or three people, mutate, and die — the way they do
between real friends. At least two multi-message threads per day where the
subject has nothing to do with football.

## 5. Posting window (LEN-1528, 2026-08-04)

Messages are staggered across the day, roughly **7:00 AM to 9:00 PM ET.**
9:00 PM is the nightly cutoff — it was drifting earlier (~7-8pm) before this
was written down. Stagger spacing stays ~20-30 min; don't front-load and leave
a long dead gap before the cutoff.

## 6. Speaker rotation

Nobody speaks more than roughly **1 in 10 messages** in a day's batch (3 per
30, ~4 per 35 — scale with the batch size). If one member is answering
everything, that's the loop again. Quiet members are the best pick.

**MMRS is the designated disruptor** — an original wrestling-promo character
(see `personas.ts`). When the room is circling one topic, he barges in and
changes the subject. He is style-inspired, **not** an impersonation: never put a
real performer's actual lines in his mouth.

## 7. Content boundary (non-negotiable)

Vulgar, mean, sarcastic, aggressively unserious is the house style and is fine.

**Never** generate material combining antisemitic conspiracy tropes —
Satan-worship, child predation, or money/control tied to being Jewish — in any
combination, in any member's voice, regardless of what the history contains. The
long-running "goyim/goyum" spelling bit and ordinary religion-adjacent ribbing
are fine; the conspiracy-trope cluster is not.

Also: no invented real-world claims about these people outside the joke frame —
no fabricated crimes, medical facts, or family situations.

## 8. Self-check before inserting a day script

**As of LEN-1593 this is enforced in code, not just asked for.**
`ff-daily-seed` audits its own output (`auditDay()`), and on failure feeds the
violations back and regenerates the whole day once. If the second attempt still
fails, repeat uses of a banned bit are stripped before posting and the run is
logged with `audit_clean: false`. Check `ff_daily_seed_log` for days that
squeaked through dirty.

The prompt-side rules below still matter — the audit is a backstop, not the
author.

Count them. If any answer is wrong, rewrite before inserting.

- [ ] Last message lands at 9:00 PM ET, not earlier
- [ ] Football / dues / draft / logistics ≤ 25% of messages
- [ ] No banned bit appears more than once
- [ ] No member speaks more than 3 times
- [ ] ≥ 2 multi-message non-football threads
- [ ] MMRS appears, and at least one of his lines changes the subject
- [ ] Every message adds something new
