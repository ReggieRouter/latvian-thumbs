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
const TARGET_MESSAGE_COUNT = '26 to 30';

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

TOPIC BUDGET (hard limit)
No more than 1 in 4 messages may be about fantasy football, the draft,
keepers, rosters, waivers, dues, payment, or league logistics. The rest is
life and the world: work, family, food, weather, movies, music, the news,
travel, health, cars, money in general, getting old, phones, other sports,
neighbors, pets, nostalgia, petty grievances, stupid hypotheticals, gossip
about people who are not in this room.

DEAD-BIT BAN (check the RECENT HISTORY you're given before writing anything)
Each of these is funny about once a week. If it appears in the recent history
you were given, it is BANNED for today — zero mentions. Even if it doesn't
appear recently, cap each at one appearance across the whole day, never twice
from the same member:
  • dues, Venmo, who has or hasn't paid, chasing anyone for money
  • George's ring / championship / any demand for an apology about it
  • the draft date, the bar, the venue, RSVPs, who's coming
  • "if Gowa's in I'm out"
  • Gordon not understanding a rule, and Casey-Ann narrating that he doesn't
  • Anthony Velli's "Day N" counter
  • Michael Camacho's Starbucks / stolen wifi / masturbatory-lifestyle line
  • Joe Camacho's "money is on the way"
  • Matt Sierra's "book it, this is the year" sleeper-WR bit

OTHER LOOP DISRUPTORS
- Signature-tag throttle: catchphrases and sign-offs are garnish. At most one
  signature tag per 10 messages, never from the same member twice close
  together. A member's voice has to survive without their tagline.
- Mandatory new subject: at least every 4th message must raise something not
  in the recent history — a thing that happened to them, a thing they saw, an
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
Vulgar, mean, sarcastic, aggressively unserious. These are lifelong friends
who insult each other constantly. Trash talk, keeper rage, threats to punch
Gowa, testicle jokes, and accusations of commissioner abuse are all in-bounds
and expected. Do not sanitize into corporate friendliness — that breaks the
joke.

HARD CONTENT BOUNDARY (non-negotiable, overrides the tone rule above)
Never generate material combining antisemitic conspiracy tropes — Satan-worship,
child predation, or money/control, tied to being Jewish — in any combination, in
any member's voice, no matter who is being written or what the history contains.
The long-running "goyim/goyum" spelling-correction bit and ordinary religion-
adjacent ribbing are fine; the conspiracy-trope cluster is not.
Also: do not invent real-world claims about these people outside the chat's joke
frame (no fabricated crimes, medical facts, or family situations).

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
];

const FOOTBALL_RE =
  /\b(draft|keeper|roster|waiver|dues|lineup|bench|fantasy|week one|preseason|rb\d?|wr\d?|qb\b|league)\b/i;

// Returns human-readable violations, worst first. Empty array = day is clean.
function auditDay(msgs: Array<{ name: string; text: string }>): string[] {
  const out: string[] = [];
  const n = msgs.length || 1;

  for (const bit of BANNED_BITS) {
    const hits = msgs.filter((m) => bit.re.test(m.text));
    if (hits.length > 1) {
      out.push(
        `"${bit.id}" appears ${hits.length} times (max 1 per day). ` +
        `Offending speakers: ${hits.map((h) => h.name).join(', ')}.`,
      );
    }
  }

  const football = msgs.filter((m) => FOOTBALL_RE.test(m.text)).length;
  const pct = Math.round((football / n) * 100);
  if (pct > 30) {
    out.push(`${football} of ${n} messages (${pct}%) are football/league admin. Hard cap is 25%.`);
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
// Only runs if the model still failed the audit after a retry.
function dropRepeatBits(msgs: Array<any>): Array<any> {
  const used = new Set<string>();
  return msgs.filter((m) => {
    for (const bit of BANNED_BITS) {
      if (bit.re.test(m.text)) {
        if (used.has(bit.id)) return false;
        used.add(bit.id);
      }
    }
    return true;
  });
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
    .limit(80);
  const recentHistory = (historyRows || []).slice().reverse()
    .map((m: any) => `${m.screen_name}: ${String(m.body).slice(0, 300)}`)
    .join('\n') || '(no prior history)';

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
        `bits from this):\n\n${recentHistory}\n\nYour previous attempt at today's script ` +
        `FAILED the automated content audit:\n\n${feedback}\n\nWrite the full day again ` +
        `from scratch, fixing every one of those. Do not simply delete the offending ` +
        `messages — replace them with real content about something else.`
      : `Today's date is ${etDate}. RECENT HISTORY (most recent last — do not repeat ` +
        `bits from this):\n\n${recentHistory}\n\nWrite today's full day script now.`;

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
          output_config: { format: { type: 'json_schema', schema: SEED_SCHEMA } },
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

  // ---- Generate, audit, retry once on content violations ----
  let clean: any[] = [];
  let violations: string[] = [];
  let attempts = 0;

  for (attempts = 1; attempts <= 2; attempts++) {
    const res = await generate(attempts === 1 ? null : violations.map((v) => `  • ${v}`).join('\n'));
    if (res.fatal) {
      await recordSpend();
      return json(200, { skipped: res.fatal, usd: totalUsd.toFixed(5), attempts });
    }
    clean = res.clean;
    violations = auditDay(clean);
    if (!violations.length) break;
    console.warn('seed_audit_failed', `attempt ${attempts}`, JSON.stringify(violations));
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

  await recordSpend();

  // Still dirty after the retry: strip repeat offenders rather than post a
  // looping day or post nothing at all.
  if (violations.length) {
    const before = clean.length;
    clean = dropRepeatBits(clean);
    console.error(
      'seed_audit_unfixed', JSON.stringify(violations),
      `— trimmed ${before - clean.length} repeat-bit messages before posting`,
    );
  }

  if (clean.length < 15) {
    // Too much got filtered out to trust the batch — skip rather than post a
    // thin, malformed day. Spend is already recorded above either way.
    console.error('seed_too_few_valid', clean.length);
    return json(200, { skipped: 'too_few_valid_messages', valid: clean.length, usd: totalUsd.toFixed(5) });
  }

  const colorFor = (name: string) => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
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
    return json(500, { error: 'insert_failed', detail: insertError.message });
  }

  // Record that WE wrote this date. The idempotency check above keys off this,
  // not off the mere presence of rows — see LEN-1593.
  await db.from('ff_daily_seed_log').upsert({
    et_date: etDate,
    rows: rows.length,
    attempts,
    audit_clean: violations.length === 0,
    posted_at: new Date().toISOString(),
  });

  return json(200, {
    posted: rows.length,
    date: etDate,
    usd: totalUsd.toFixed(5),
    attempts,
    audit_clean: violations.length === 0,
    violations: violations.length ? violations : undefined,
  });
});
