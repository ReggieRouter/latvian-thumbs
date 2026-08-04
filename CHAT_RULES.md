# Latvian Thumbs — chat content rules (LEN-1528)

**Read this before writing a single chat line, by any path.**

There are two ways messages get into `ff_chat_messages`, and the rules below
apply to BOTH. Getting this wrong in one path while fixing the other is what
happened on 2026-08-04 and is the whole reason this file exists.

| Path | What it is | Where the rules live |
|---|---|---|
| **Reactive bots** | `supabase/functions/ff-bot-reply` — a human posts, Claude answers in character | `INSTRUCTIONS` in `index.ts` |
| **Pre-seeded day script** | ~30 rows bulk-inserted in advance with staggered future `created_at`, so the room looks alive all day | **this file** — there is no code, a human/agent writes the batch |

The pre-seeded path is the one people actually read most days. It had no written
rules at all until now, which is how it drifted.

> **Tell them apart in the DB:** pre-seeded rows have whole-second timestamps
> (`created_at` microseconds = 0). Genuine live `pg_cron` and reactive inserts
> have fractional seconds.

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

## 5. Speaker rotation

Nobody speaks more than **3 times** in a 30-message day. If one member is
answering everything, that's the loop again. Quiet members are the best pick.

**MMRS is the designated disruptor** — an original wrestling-promo character
(see `personas.ts`). When the room is circling one topic, he barges in and
changes the subject. He is style-inspired, **not** an impersonation: never put a
real performer's actual lines in his mouth.

## 6. Content boundary (non-negotiable)

Vulgar, mean, sarcastic, aggressively unserious is the house style and is fine.

**Never** generate material combining antisemitic conspiracy tropes —
Satan-worship, child predation, or money/control tied to being Jewish — in any
combination, in any member's voice, regardless of what the history contains. The
long-running "goyim/goyum" spelling bit and ordinary religion-adjacent ribbing
are fine; the conspiracy-trope cluster is not.

Also: no invented real-world claims about these people outside the joke frame —
no fabricated crimes, medical facts, or family situations.

## 7. Self-check before inserting a day script

Count them. If any answer is wrong, rewrite before inserting.

- [ ] Football / dues / draft / logistics ≤ 25% of messages
- [ ] No banned bit appears more than once
- [ ] No member speaks more than 3 times
- [ ] ≥ 2 multi-message non-football threads
- [ ] MMRS appears, and at least one of his lines changes the subject
- [ ] Every message adds something new
