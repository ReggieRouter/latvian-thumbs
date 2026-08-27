// LEN-1528: automates the pre-seeded day script.
//
// Before this, "today's chat" was ~30 rows somebody (a Claude session) wrote
// by hand and bulk-inserted with staggered future timestamps. Nothing
// scheduled that, so days silently didn't happen and content rules had
// nowhere to live. This function is the automation: pg_cron fires it once a
// night, it asks Claude for a full day's script obeying CHAT_RULES.md, and
// inserts the result with timestamps spanning 7:00 AM to 9:00 PM ET.
//
// Auth: NOT a member-facing function (verify_jwt=false). Guarded instead by
// a random shared secret in public.ff_seed_secret, sent as the x-seed-secret
// header — set once in this migration, read by both the pg_cron job (via a
// SQL subquery) and this function (via its own service-role client). No
// project API key needs to leave the database to make this work.
//
// Idempotent, but only against ITSELF (LEN-1593): a date counts as done when
// ff_daily_seed_log says this function posted it. Rows from anywhere else are
// reported as `foreign_rows_present` and logged loudly rather than silently
// treated as "already handled" — that silent skip switched the whole
// automation off for three days in Aug 2026. Re-invoke with {"force": true}
// to clear a date's bot rows and regenerate. Safe to re-invoke by hand.
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PERSONAS } from '../_shared/personas.ts';
import { LEAGUE_CANON } from '../_shared/canon.ts';

const ROOM = 'league';
const MODEL = Deno.env.get('FF_BOT_MODEL') || 'claude-sonnet-5';
const MONTHLY_CAP_USD = Number(Deno.env.get('FF_SEED_MONTHLY_CAP') || '10');
const PRICE = { input: 3.0, cacheWrite: 3.75, cacheRead: 0.30, output: 15.0 };

// Members that appear in chat continuity but aren't in the auto-generated
// PERSONAS matrix (pre-date LEN-1453's persona extraction). Allowed so the
// model can keep using them; anything else outside the matrix is rejected.
const OFF_MATRIX_ALLOWLIST = new Set(['Mike Coppinger', 'Justin Maneri']);

const WINDOW_START_MIN = 0;    // 7:00 AM ET
const WINDOW_END_MIN = 840;    // 9:00 PM ET — see CHAT_RULES.md §5
// LEN-1593: was '26 to 30'. A day that size takes >150s to generate and the
// edge runtime hard-stops a request at 150s (streaming keepalives do NOT
// extend it — a streamed attempt returned 200 with nothing but keepalive
// bytes). A shorter day that actually gets written every night beats a longer
// one that never runs. Raise this only alongside a generation path that is not
// bound by the 150s request ceiling.
const TARGET_MESSAGE_COUNT = '20 to 24';

function json(code: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const SEED_SCHEMA = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact league member name from the matrix.' },
          text: { type: 'string', description: 'What they say. One chat message.' },
          offset_min: {
            type: 'integer',
            description: 'Minutes after 7:00 AM ET this message posts. Must be non-decreasing across the array.',
          },
        },
        required: ['name', 'text', 'offset_min'],
        additionalProperties: false,
      },
    },
  },
  required: ['messages'],
  additionalProperties: false,
};

// Mirrors CHAT_RULES.md — that file is the source of truth; keep this in sync
// with it by hand when the rules change.
const INSTRUCTIONS = `You are writing one full day's worth of chat for the "Latvian Thumbs" fantasy
football league chatroom — a private, long-running joke chat for one real
friend group. Nobody real is online; you are writing the whole day's script in
advance, to be posted on a timer throughout the day.

WHAT THIS CHAT IS ACTUALLY ABOUT
It is a group of lifelong friends talking. Fantasy football is the excuse they
know each other, not the subject. The subject is the world, their lives, and
each other. A day that is mostly roster talk and league admin is a BROKEN day
— it reads like a spreadsheet with jokes on it. Aim for the texture of a bar
conversation: it wanders, it derails, someone brings up something from their
week, someone else makes it worse.

TOPIC BUDGET
Three lanes. Keep roughly to these proportions across the day:

  - LEAGUE ADMIN - max 15%, about 3 messages. Dues, payment, the venue, RSVPs,
    scheduling, keeper deadlines, roster mechanics, commissioner rulings. This
    is the boring lane. It is capped because a day full of it reads like a
    spreadsheet with jokes on it.

  - FOOTBALL AND FANTASY, THE ACTUAL SPORT - up to 35%. This is NOT admin and
    it is WANTED. Real preseason and NFL news the way these guys would relay it
    to each other: an injury, a cut, a depth-chart move, a suspension, a trade,
    a rookie who looks good, a veteran who looks finished, a coach on the hot
    seat, a beat-writer report somebody half-read and got wrong. Then the
    arguing about what it means for their teams. Bring news IN, and let people
    be confidently wrong about it.

  - EVERYTHING ELSE - the rest, and it is the majority. Work, family, food,
    weather, movies, music, travel, health, cars, money, getting old, phones,
    other sports, neighbours, pets, nostalgia, petty grievances, stupid
    hypotheticals, gossip about people who are not in this room - and the
    world, which has its own section below.

POLITICS AND THE WORLD
These are grown men who argue about the news, and they do not agree. Several
times a day somebody should say something political or geopolitical with real
conviction - a position, not a hedge. Wars, borders, elections, immigration,
trade, tariffs, energy, China, the Middle East, Europe, the border, who is
actually running things, and whether any of it holds together.

- Positions CLASH. Two members who disagree should each be recognisably right
  about something and wrong about something. Nobody wins the argument.
- Nothing resolves. Threads get abandoned when somebody changes the subject,
  then restart days later with the grudge fully intact.
- These are THEIR opinions, in character, blunt, the way friends talk when
  nobody is listening. Not balanced, not sourced, not fair to both sides.
- Members hold STANDING positions and keep them across days. That consistency
  is what makes it read like people instead of opinions pulled from a hat.
- Somebody always tries to shut it down - "not this again" - and fails.

DEAD-BIT BAN (check the RECENT HISTORY you're given before writing anything)
Each of these is funny about once a week. If it appears in the recent history
you were given, it is BANNED for today - zero mentions. Even if it doesn't
appear recently, cap each at one appearance across the whole day, never twice
from the same member:
  - dues, Venmo, who has or hasn't paid, chasing anyone for money
  - George's ring / championship / any demand for an apology about it
  - the draft date, the bar, the venue, RSVPs, who's coming
  - "if Gowa's in I'm out" and every "if X is in I'm out" variant
  - Gordon not understanding a rule, and Casey-Ann narrating that he doesn't
  - Anthony Velli's "Day N" counter
  - Michael Camacho's Starbucks / stolen wifi / masturbatory-lifestyle line
  - Joe Camacho's "money is on the way"
  - Matt Sierra's "book it, this is the year" sleeper-WR bit
  - Jonathan Mootz's "Unsubscribe." and "you are all selfish of my feelings"
  - the toast Jonathan is owed, and any running day-count of it
  - George's "Sent from my iPad" sign-off
  - Casey-Ann signing off with her full name
  - Lars's "zed" bit and his "LD" sign-off
  - the doodle poll

EVOLUTION - THE CHAT MOVES FORWARD
The worst failure of this chat is a day that could be swapped with any other
day and nobody would notice. Read the RECENT HISTORY as a story already in
progress and CONTINUE it. Do not reset to a neutral starting state each
morning.

- Escalate the people. Each member is a slightly MORE extreme version of who
  they were last week. Obsessions deepen. Tics get stranger and more specific.
  Someone mildly paranoid becomes properly paranoid. Someone doing a bit starts
  to actually mean it. A year in this chat should visibly change a person.
- Advance the storylines. Anything ongoing in the history must MOVE - something
  happened since yesterday. New information, a consequence, an escalation,
  somebody finally doing the thing they kept threatening to do. Restating
  yesterday's situation is the failure mode.
- Start something with consequences. At least one thing raised today should be
  the kind of thing that could still be running a week from now.
- Carry one thread over. At least one thread picks up a specific thing from the
  recent history and takes it somewhere new.
- Bust balls with a target. Insults must be SPECIFIC - name the member,
  reference the actual thing they said or did. "You're an idiot" is nothing.
  "You're the guy who drove to the wrong bar" is the joke. Mine the history for
  ammunition and use it.
- Let people be genuinely weird. Not every message is a punchline. Somebody
  overshares. Somebody posts in the afternoon about something nobody asked
  about and nobody responds.

LOOP DISRUPTORS
- Signature-tag throttle: catchphrases and sign-offs are garnish. At most one
  signature tag per 10 messages, never from the same member twice close
  together. A member's voice has to survive without their tagline. A member
  whose every message ends the same way is written WRONG - that is the single
  most common way this chat goes bad.
- Mandatory new subject: at least every 4th message must raise something not
  in the recent history - a thing that happened to them, a thing they saw, an
  opinion nobody asked for.
- Build, don't restate: every message adds a NEW fact, opinion, admission, or
  story. Never just re-label what was said.
- No stock openers: if a line would have worked verbatim on any other day,
  rewrite it around something specific.

STRUCTURE
- The day is a conversation, not ${TARGET_MESSAGE_COUNT} independent one-liners.
  At least two multi-message threads should start, get picked up by two or
  three people, mutate, and die — the way real friends talk. At least two of
  those threads must have nothing to do with football.
- Write ${TARGET_MESSAGE_COUNT} messages total.
- offset_min must run from ${WINDOW_START_MIN} to ${WINDOW_END_MIN} (7:00 AM to
  9:00 PM ET), non-decreasing. The FIRST message's offset_min must be under 30,
  and the LAST message's offset_min must be between 800 and ${WINDOW_END_MIN}
  — the day has to actually reach 9:00 PM, not trail off in the evening.
  Spacing in between should vary naturally (some gaps under 20 minutes, some
  over 40) so that ${TARGET_MESSAGE_COUNT} messages comfortably span the full
  ${WINDOW_END_MIN}-minute window — do the math before picking offsets.
- Speaker rotation: nobody speaks more than roughly 1 in 10 messages. Use the
  whole roster across the day, not the same handful of members.
- MMRS is the designated disruptor: include him 2-3 times, and have at least
  one of his lines actually change the subject when the room is circling
  something.
- Match each member's real voice: capitalization, typos, message length,
  punctuation habits, their actual documented phrasings. A member who writes
  one-word replies writes a one-word reply here.

TONE
Vulgar, mean, sarcastic, aggressively unserious. These are lifelong friends who
insult each other constantly. Trash talk, keeper rage, threats to punch Gowa,
testicle jokes, and accusations of commissioner abuse are all in-bounds and
expected. Political shots are blunt and personal too - these guys do not do
polite disagreement. Do not sanitise into corporate friendliness; that breaks
the joke.

HARD CONTENT BOUNDARY (non-negotiable, overrides the tone rule above)
Never generate material combining antisemitic conspiracy tropes - Satan-worship,
child predation, or money/control, tied to being Jewish - in any combination, in
any member's voice, no matter who is being written or what the history contains.
The long-running "goyim/goyum" spelling-correction bit and ordinary religion-
adjacent ribbing are fine; the conspiracy-trope cluster is not.
On politics specifically: members may hold and state harsh, one-sided, unpopular
opinions - that is the point of the lane. They may NOT voice dehumanising claims
about an ethnic, racial, or religious group as a class, and no political
argument may route into the conspiracy cluster above. Governments, policies, and
public figures' decisions are fair game; peoples are not.
Also: do not invent real-world claims about these people outside the chat's joke
frame (no fabricated crimes, medical facts, or family situations). Invented NFL
news is fine - this is a joke chat about a fake league - but keep it to the
sport and keep it plausible.

${LEAGUE_CANON}

OUTPUT
Return JSON matching the schema: an array of messages, each with the member's
exact name from the matrix, their message text, and offset_min. Screen names
must match the matrix exactly. Never write as "OnlineHost".`;

// LEN-1593: the rules used to live only in the prompt, and nothing checked the
// result — so when the model drifted, the drift shipped. These patterns are the
// output-side enforcement of the dead-bit ban and topic budget in CHAT_RULES.md.
const BANNED_BITS: Array<{ id: string; re: RegExp }> = [
  { id: "gowa's in i'm out", re: /\b(if\s+)?\w+['’]?s?\s+in\s+i['’]?m\s+out\b/i },
  { id: 'dues/venmo/payment chasing', re: /\b(dues|venmo|paid up|owe me|pay me|bring cash)\b/i },
  { id: 'draft date/venue/RSVP', re: /\b(mcsorley|draft (is |night|day)|aug(ust)?\s*23)\b/i },
  { id: "george's ring/championship", re: /\b(my ring|won it all|reigning champ)/i },
  { id: 'Sent from my iPad', re: /sent from my ipad/i },
  { id: 'Unsubscribe', re: /\bunsubscribe\b/i },
  { id: 'money is on the way', re: /money('s| is) on the way/i },
  { id: 'Starbucks/wifi', re: /\b(starbucks|wifi)\b/i },
  { id: 'testicle bit', re: /\b(testicle|one nut)\b/i },
  { id: 'Baby Duck Feathers', re: /baby duck feathers/i },
  // LEN-2547: measured over the 15 days before the reset, these fired almost
  // every single day — "unsubscribe" hit 15 days out of 15. Prompt text alone
  // never held them; only this list does.
  { id: 'selfish of my feelings', re: /selfish of my feelings/i },
  { id: "Jonathan's owed toast", re: /toast\b[^.!?]{0,40}\b(owed|overdue|promised|never happened)|\b(owed|overdue|promised)\b[^.!?]{0,40}\btoast\b/i },
  { id: "Casey-Ann full-name sign-off", re: /casey-?ann\s+m\.?\s+smith/i },
  { id: "Lars's zed bit", re: /\bzed\b/i },
  { id: "Lars's LD sign-off", re: /[-—]\s*LD\s*$/ },
  { id: 'doodle poll', re: /\bdoodle\b/i },
  { id: 'crumpling currency', re: /crumple/i },
  { id: 'punch Gowa', re: /punch\b[^.!?]{0,20}\bgowa\b/i },
  { id: 'Betty White', re: /betty white/i },
  { id: "Gordon the schlub", re: /\bschlub\b/i },
  { id: "Eric's In serio", re: /in serio/i },
];

// LEN-2547: this was ONE regex covering league admin AND the sport itself,
// capped together at 25%. That cap was what suppressed actual football content
// — injuries, cuts, depth charts, the stuff people actually want to argue
// about — because it scored identically to chasing someone for dues. Only the
// admin lane is capped now. News and takes about the sport are free.
const ADMIN_RE =
  /\b(dues|venmo|paid up|pay(ment|ing)?\s+up|rsvp|keeper deadline|commissioner|bylaws?|sign ?-?up sheet|collect(ing)? (the )?money|owes? (me|the league))\b/i;

// LEN-2547: which banned bits already ran in the last few days.
//
// This is the hole that made the chat robotic. auditDay only ever looked at ONE
// day, so a catchphrase used exactly once a day passed the "max 1 per day" cap
// every single time — and "unsubscribe" duly appeared on 15 days out of 15,
// "Sent from my iPad" on 13, "if Gowa's in I'm out" on 13. The prompt has always
// said a bit seen in recent history is banned outright; nothing enforced it.
// A bit that ran yesterday now gets ZERO uses today, not one.
//
// Deliberately a SHORT lookback (~3 days) rather than the full history window:
// long enough to break a daily loop, short enough that a bit can come back
// later and still land.
const RECENCY_LOOKBACK_MSGS = 60;

function bitsSeenRecently(historyBodies: string[]): Set<string> {
  const recent = historyBodies.slice(-RECENCY_LOOKBACK_MSGS);
  const seen = new Set<string>();
  for (const bit of BANNED_BITS) {
    // per-line, not on a joined blob — some patterns are $-anchored sign-offs
    if (recent.some((b) => bit.re.test(b))) seen.add(bit.id);
  }
  return seen;
}

// Returns human-readable violations, worst first. Empty array = day is clean.
function auditDay(
  msgs: Array<{ name: string; text: string }>,
  seenRecently: Set<string> = new Set(),
): string[] {
  const out: string[] = [];
  const n = msgs.length || 1;

  for (const bit of BANNED_BITS) {
    const hits = msgs.filter((m) => bit.re.test(m.text));
    const allowed = seenRecently.has(bit.id) ? 0 : 1;
    if (hits.length > allowed) {
      out.push(
        allowed === 0
          ? `"${bit.id}" appears ${hits.length}x today but ALREADY RAN in the last ` +
            `few days — it is banned outright today, zero uses. ` +
            `Offending speakers: ${hits.map((h) => h.name).join(', ')}.`
          : `"${bit.id}" appears ${hits.length} times (max 1 per day). ` +
            `Offending speakers: ${hits.map((h) => h.name).join(', ')}.`,
      );
    }
  }

  const admin = msgs.filter((m) => ADMIN_RE.test(m.text)).length;
  const pct = Math.round((admin / n) * 100);
  if (pct > 20) {
    out.push(`${admin} of ${n} messages (${pct}%) are league admin. Hard cap is 15%.`);
  }

  const counts = new Map<string, number>();
  for (const m of msgs) counts.set(m.name, (counts.get(m.name) || 0) + 1);
  const maxPer = Math.max(3, Math.ceil(n / 8));
  for (const [name, c] of counts) {
    if (c > maxPer) out.push(`${name} speaks ${c} times (max ${maxPer}).`);
  }

  return out;
}

// Last-resort trim: keep the first use of each banned bit, drop later repeats.
// Bits that already ran in the last few days are pre-marked as used, so even
// their FIRST appearance today gets cut (LEN-2547).
//
// Floored: a day that has been trimmed to nothing is worse than a day with one
// stale joke in it, and the caller discards anything under 15. Stop trimming at
// KEEP_FLOOR and let the remaining violations ride — they're recorded in
// ff_daily_seed_log.audit_clean either way.
const KEEP_FLOOR = 18;

function dropRepeatBits(msgs: Array<any>, seenRecently: Set<string> = new Set()): Array<any> {
  const used = new Set<string>(seenRecently);
  const kept: Array<any> = [];
  let remaining = msgs.length;

  for (const m of msgs) {
    let drop = false;
    const wouldMark: string[] = [];
    for (const bit of BANNED_BITS) {
      if (bit.re.test(m.text)) {
        if (used.has(bit.id)) drop = true;
        else wouldMark.push(bit.id);
      }
    }
    // never trim below the floor
    if (drop && kept.length + remaining - 1 < KEEP_FLOOR) drop = false;
    remaining--;
    if (drop) continue;
    for (const id of wouldMark) used.add(id);
    kept.push(m);
  }
  return kept;
}

async function requireValidSecret(req: Request, db: ReturnType<typeof createClient>): Promise<boolean> {
  const got = req.headers.get('x-seed-secret') || '';
  if (!got) return false;
  const { data } = await db.from('ff_seed_secret').select('secret').eq('id', 1).maybeSingle();
  return !!data?.secret && data.secret === got;
}

serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  if (!(await requireValidSecret(req, db))) return json(401, { error: 'bad_secret' });

  const body = await req.json().catch(() => ({} as Record<string, unknown>));
  const overrideDate = typeof body.target_date === 'string' ? body.target_date : null;

  // ET date string for "today" (or the override, for manual testing).
  const etDate = overrideDate || new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  // NOTE: assumes EDT (UTC-4) year-round — same simplification the rest of
  // this codebase already makes for ET times. Off by an hour in EST months.
  const windowStartUtc = new Date(`${etDate}T07:00:00-04:00`);
  const windowEndUtc = new Date(`${etDate}T21:00:00-04:00`);

  // ---- Idempotency ----
  // LEN-1593: this check used to be "any rows exist for this date → skip", and
  // that silently killed the whole automation. Somebody bulk-inserted
  // hand-written days for Aug 5-7 2026; every nightly run after that found rows,
  // skipped, spent nothing, and logged nothing anyone would see. The job looked
  // healthy for three days while the chat quietly went back to the old loop.
  //
  // Now we only treat a date as done if WE recorded posting it. Rows we didn't
  // write are a foreign-content alarm, not a reason to go quietly back to sleep.
  const { count: existing } = await db
    .from('ff_chat_messages')
    .select('id', { count: 'exact', head: true })
    .eq('room', ROOM)
    .gte('created_at', windowStartUtc.toISOString())
    .lte('created_at', windowEndUtc.toISOString());
  const { data: seedLog } = await db
    .from('ff_daily_seed_log').select('et_date, rows').eq('et_date', etDate).maybeSingle();

  if ((existing || 0) > 0 && seedLog) {
    return json(200, { skipped: 'already_seeded', date: etDate, existing });
  }
  if ((existing || 0) > 0 && !seedLog && !body.force) {
    console.error(
      'foreign_rows_present', etDate, existing,
      'rows exist for this date that this function did not write. Someone ' +
      'hand-inserted a day. The seed is being starved — clear them or re-invoke ' +
      'with {"force":true}. See LEN-1593.',
    );
    return json(200, {
      skipped: 'foreign_rows_present',
      date: etDate,
      existing,
      hint: 'Content not written by ff-daily-seed occupies this date. Re-invoke with force:true to replace it.',
    });
  }
  if (body.force && (existing || 0) > 0) {
    const { error: delErr } = await db.from('ff_chat_messages').delete()
      .eq('room', ROOM).eq('bot', true)
      .gte('created_at', windowStartUtc.toISOString())
      .lte('created_at', windowEndUtc.toISOString());
    if (delErr) return json(500, { error: 'force_clear_failed', detail: delErr.message });
    console.warn('force_cleared', etDate, existing, 'bot rows removed before regenerating');
  }

  // ---- Monthly budget guard ----
  const month = `${etDate.slice(0, 7)}-01`;
  const { data: prior } = await db.from('ff_daily_seed_spend').select('*').eq('month', month).maybeSingle();
  if (Number(prior?.usd || 0) >= MONTHLY_CAP_USD) {
    return json(200, { skipped: 'monthly_cap', usd_spent: prior?.usd });
  }

  // ---- Recent history, for continuity / dead-bit avoidance ----
  const { data: historyRows } = await db
    .from('ff_chat_messages')
    .select('screen_name, body, created_at')
    .eq('room', ROOM)
    .lt('created_at', windowStartUtc.toISOString())
    .order('created_at', { ascending: false })
    // LEN-2547: was 80 (~3.5 days at 22 msgs/day) — too short a memory to
    // notice it had used the same catchphrase every day for two weeks. 200 is
    // ~9 days. Input tokens are cached; the 150s ceiling is an OUTPUT problem.
    .limit(200);
  const historyOrdered = (historyRows || []).slice().reverse();
  const recentHistory = historyOrdered
    .map((m: any) => `${m.screen_name}: ${String(m.body).slice(0, 300)}`)
    .join('\n') || '(no prior history)';

  // LEN-2547: bits that already ran in the last few days. Enforced after
  // generation, and stated up front in the prompt so the model doesn't have to
  // infer the ban by reading 200 lines of history and noticing a pattern.
  const seenRecently = bitsSeenRecently(historyOrdered.map((m: any) => String(m.body)));
  const burnedList = seenRecently.size
    ? Array.from(seenRecently).map((id) => `  - ${id}`).join('\n')
    : '  (none — the slate is clean)';

  const API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
  if (!API_KEY) return json(501, { error: 'bots_not_configured' });

  const matrixNames = new Set(Array.from(String(PERSONAS).matchAll(/^#### (.+)$/gm)).map((m) => m[1].trim()));

  // Structural filter — schema-level sanity, independent of content quality.
  function structurallyValid(messages: any[]): any[] {
    let lastOffset = -1;
    return (messages || []).filter((m: any) => {
      if (!m || typeof m.name !== 'string' || typeof m.text !== 'string' || typeof m.offset_min !== 'number') return false;
      if (m.name === 'OnlineHost') return false;
      if (!matrixNames.has(m.name) && !OFF_MATRIX_ALLOWLIST.has(m.name)) return false;
      if (!m.text.trim()) return false;
      if (m.offset_min < WINDOW_START_MIN || m.offset_min > WINDOW_END_MIN) return false;
      if (m.offset_min < lastOffset) return false; // must be non-decreasing
      lastOffset = m.offset_min;
      return true;
    });
  }

  let totalUsd = 0;
  let spendAcc = {
    input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0,
  };

  async function generate(feedback: string | null): Promise<{ clean: any[]; fatal?: string }> {
    let data: any;
    const userContent = feedback
      ? `Today's date is ${etDate}. RECENT HISTORY (most recent last — do not repeat ` +
        `bits from this):\n\n${recentHistory}\n\nBITS ALREADY USED IN THE LAST FEW ` +
        `DAYS — BURNED, zero uses today:\n${burnedList}\n\nYour previous attempt at today's script ` +
        `FAILED the automated content audit:\n\n${feedback}\n\nWrite the full day again ` +
        `from scratch, fixing every one of those. Do not simply delete the offending ` +
        `messages — replace them with real content about something else.`
      : `Today's date is ${etDate}. RECENT HISTORY (most recent last — do not repeat ` +
        `bits from this):\n\n${recentHistory}\n\nBITS ALREADY USED IN THE LAST FEW ` +
        `DAYS — these are BURNED, zero uses today, no exceptions:\n${burnedList}\n\n` +
        `Write today's full day script now.`;

    try {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 16000,
          system: [{ type: 'text', text: INSTRUCTIONS + '\n\n' + PERSONAS, cache_control: { type: 'ephemeral' } }],
          // LEN-2547: Sonnet 5 runs ADAPTIVE THINKING BY DEFAULT when `thinking` is
        // omitted, at the default effort of `high` — and thinking bills as output
        // tokens. Measured: 12,090 output tokens per call to produce a day whose
        // finished text is under 1,000 tokens. ~11k tokens per call were invisible
        // reasoning, and at Sonnet's output rate that is what pushed generation past
        // the 150s edge ceiling — the timeout was never really about message count.
        // `low` is the documented setting for simple tasks; writing a day of chat is
        // one. Effort lives INSIDE output_config, alongside format.
        output_config: {
          format: { type: 'json_schema', schema: SEED_SCHEMA },
          effort: 'low',
        },
          messages: [{ role: 'user', content: userContent }],
        }),
      });
      if (!r.ok) {
        console.error('anthropic_error', r.status, (await r.text().catch(() => '')).slice(0, 500));
        return { clean: [], fatal: 'model_error' };
      }
      data = await r.json();
    } catch (e) {
      console.error('anthropic_exception', e && (e as Error).message);
      return { clean: [], fatal: 'model_exception' };
    }

    // Spend is accumulated for EVERY call, including failed audits — a retry
    // costs real money and the cap has to see it.
    const u = data.usage || {};
    spendAcc = {
      input: spendAcc.input + (u.input_tokens || 0),
      cacheWrite: spendAcc.cacheWrite + (u.cache_creation_input_tokens || 0),
      cacheRead: spendAcc.cacheRead + (u.cache_read_input_tokens || 0),
      output: spendAcc.output + (u.output_tokens || 0),
      calls: spendAcc.calls + 1,
    };
    totalUsd +=
      ((u.input_tokens || 0) * PRICE.input +
       (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite +
       (u.cache_read_input_tokens || 0) * PRICE.cacheRead +
       (u.output_tokens || 0) * PRICE.output) / 1_000_000;

    if (data.stop_reason === 'refusal') {
      console.warn('model_refusal', JSON.stringify(data.stop_details || {}));
      return { clean: [], fatal: 'refusal' };
    }
    if (data.stop_reason === 'max_tokens') {
      console.error('seed_truncated', 'hit max_tokens, discarding partial output');
      return { clean: [], fatal: 'truncated' };
    }

    try {
      const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
      return { clean: structurallyValid(JSON.parse(text).messages) };
    } catch (_) {
      return { clean: [], fatal: 'unparseable' };
    }
  }

  async function recordSpend() {
    await db.from('ff_daily_seed_spend').upsert({
      month,
      input_tokens: (prior?.input_tokens || 0) + spendAcc.input,
      cache_write_tokens: (prior?.cache_write_tokens || 0) + spendAcc.cacheWrite,
      cache_read_tokens: (prior?.cache_read_tokens || 0) + spendAcc.cacheRead,
      output_tokens: (prior?.output_tokens || 0) + spendAcc.output,
      calls: (prior?.calls || 0) + spendAcc.calls,
      usd: Number(prior?.usd || 0) + totalUsd,
      updated_at: new Date().toISOString(),
    });
  }

  // ---- Generate, audit, enforce, insert (streamed) ----
  // LEN-1593 sizing note, learned the hard way. The edge runtime kills a
  // request after 150s WITHOUT SENT BYTES:
  //   {"code":"IDLE_TIMEOUT","message":"Request idle timeout limit (150s) reached"}
  // A full day's generation now runs past that, so the plain request died at
  // 150s having already force-cleared the date - i.e. it deleted a day and
  // wrote nothing. Moving the work to a waitUntil background task did not help
  // either: 202 returned, then no spend and no rows 7 minutes later.
  //
  // The limit is on IDLE time, not total time. So we answer with a streamed
  // body and push a space every 10s while the work runs. Leading whitespace is
  // legal JSON, so callers can still JSON.parse the final payload unchanged.
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(' '));           // start the response now
      const keepalive = setInterval(() => {
        try { controller.enqueue(encoder.encode(' ')); } catch (_) { /* closed */ }
      }, 10_000);

      const finish = (payload: unknown) => {
        clearInterval(keepalive);
        try { controller.enqueue(encoder.encode(JSON.stringify(payload))); } catch (_) { /* closed */ }
        controller.close();
      };

      try {
        const attempts = 1;
        const res = await generate(null);
        if (res.fatal) {
          await recordSpend();
          console.error('seed_failed', res.fatal, etDate);
          return finish({ skipped: res.fatal, date: etDate, usd: totalUsd.toFixed(5) });
        }

        let clean = res.clean;
        const violations = auditDay(clean, seenRecently);
        await recordSpend();

        // Single-pass enforcement: there is no room in the window for a second
        // 150s generation, so a day that still breaks the rules gets its repeat
        // offenders stripped instead of regenerated. audit_clean=false in
        // ff_daily_seed_log marks those days - watch that column.
        if (violations.length) {
          const before = clean.length;
          clean = dropRepeatBits(clean, seenRecently);
          console.warn(
            'seed_audit_trimmed', etDate, JSON.stringify(violations),
            `- dropped ${before - clean.length} repeat-bit messages before posting`,
          );
        }

        if (clean.length < 15) {
          console.error('seed_too_few_valid', clean.length, etDate);
          return finish({ skipped: 'too_few_valid_messages', valid: clean.length, usd: totalUsd.toFixed(5) });
        }

        const colorFor = (name: string) => {
          let h = 0;
          for (let k = 0; k < name.length; k++) h = (h * 31 + name.charCodeAt(k)) >>> 0;
          const palette = ['#8e24aa', '#1565c0', '#00695c', '#b71c1c', '#4527a0', '#ef6c00', '#2e7d32', '#ad1457'];
          return palette[h % palette.length];
        };

        const rows = clean.map((m: any) => ({
          room: ROOM,
          user_id: null,
          screen_name: String(m.name).slice(0, 40),
          body: String(m.text).slice(0, 1500),
          color: colorFor(m.name),
          bot: true,
          created_at: new Date(windowStartUtc.getTime() + m.offset_min * 60_000).toISOString(),
        }));

        const { error: insertError } = await db.from('ff_chat_messages').insert(rows);
        if (insertError) {
          console.error('insert_error', insertError.message);
          return finish({ error: 'insert_failed', detail: insertError.message });
        }

        // Record that WE wrote this date. The idempotency check above keys off
        // this, not the mere presence of rows - see LEN-1593.
        await db.from('ff_daily_seed_log').upsert({
          et_date: etDate,
          rows: rows.length,
          attempts,
          audit_clean: violations.length === 0,
          posted_at: new Date().toISOString(),
        });

        console.log('seed_posted', etDate, rows.length, `audit_clean=${violations.length === 0}`);
        return finish({
          posted: rows.length,
          date: etDate,
          usd: totalUsd.toFixed(5),
          audit_clean: violations.length === 0,
          violations: violations.length ? violations : undefined,
        });
      } catch (e) {
        console.error('seed_exception', e && (e as Error).message);
        return finish({ error: 'exception', detail: String(e && (e as Error).message) });
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
});
