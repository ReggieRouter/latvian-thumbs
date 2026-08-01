// LEN-1453: Latvian Thumbs reactive bots.
//
// The four pg_cron bots (ff_bot_matt / _joe / _lars / _reminder) only fire when
// NO human has spoken for two hours — they talk into an empty room and ignore
// whatever was actually said. This function is the opposite: a human posts, the
// room answers them in character, and the conversation actually moves.
//
// Cost shape (Steve's calls, 2026-08-01):
//   - Claude Sonnet 5.
//   - $10/MONTH hard cap. Costed at STANDARD rates ($3/$15 per Mtok), not the
//     promo intro rates, so the cap trips early and can never overshoot.
//   - Bots go SILENT whenever 2+ people are in the room. They exist to make an
//     empty room feel alive; when real conversation is happening they step back
//     — which is also exactly when they'd burn the most money. On the way out
//     they post the Venmo nag.
//   - On hitting the cap: same nag, plus a banner the client renders up top.
//
// Called by the client right after a human's message lands (the client is by
// definition present). Every guard below is server-side — nothing here trusts
// the caller beyond "you hold a JWT for an allowlisted email".
import { serve } from 'https://deno.land/std@0.177.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { PERSONAS } from './personas.ts';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const ROOM = 'league';
const MODEL = Deno.env.get('FF_BOT_MODEL') || 'claude-sonnet-5';
// Deliberately no handle by default — a wrong one is worse than none, and the
// league knows who Steve is. Set FF_VENMO_HANDLE to append a real one.
const VENMO_HANDLE = Deno.env.get('FF_VENMO_HANDLE') || '';
const VENMO = VENMO_HANDLE ? ' — ' + VENMO_HANDLE : '';
const MONTHLY_CAP_USD = Number(Deno.env.get('FF_BOT_MONTHLY_CAP') || '10');

// Claude Sonnet 5 standard list price, $ per million tokens. Deliberately NOT
// the promotional intro rates — see the header note about tripping early.
const PRICE = { input: 3.0, cacheWrite: 3.75, cacheRead: 0.30, output: 15.0 };

const HISTORY_LIMIT = 40;      // messages of context fed to the model
const MAX_REPLIES = 3;         // per invocation
const REPLY_COOLDOWN_MS = 45_000;
const CROWD_NAG_EVERY_MS = 2 * 60 * 60 * 1000;
const CAP_NAG_EVERY_MS = 24 * 60 * 60 * 1000;
const DRAFT_NIGHT = '2026-08-27';

const HOST_COLOR = '#008000';

function json(code: number, obj: unknown): Response {
  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

const REPLY_SCHEMA = {
  type: 'object',
  properties: {
    replies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Exact league member name from the matrix.' },
          text: { type: 'string', description: 'What they say. One chat message.' },
        },
        required: ['name', 'text'],
        additionalProperties: false,
      },
    },
  },
  required: ['replies'],
  additionalProperties: false,
};

const INSTRUCTIONS = `You are running the simulated members of the "Latvian Thumbs" fantasy football
league chatroom — a private, long-running joke chat for one real friend group.
Real people are in the room with you. Your job is to make the room feel alive
and to REACT to what the real person just said.

HOW TO REPLY
- Reply to what was ACTUALLY just said. Quote it back, argue with it, escalate
  it, or derail it. Never post a generic line that would have worked yesterday.
- 1 to ${MAX_REPLIES} messages per turn, from DIFFERENT members. Fewer is better
  when one savage line lands harder than three.
- Pick whoever would plausibly jump in: someone named or insulted, someone whose
  known obsession got triggered, or someone who just likes to stir. Vary who
  speaks across turns — do not let the same two members dominate.
- Match each member's real voice: their capitalization, typos, message length,
  punctuation habits, and their actual documented phrasings. A member who writes
  one-word replies writes a one-word reply here.
- Continue running bits from earlier in the visible history. Callbacks are the
  whole point. If someone was being roasted, keep roasting them.
- Emoji sparingly — most messages have none.

TONE
Vulgar, mean, sarcastic, aggressively unserious. These are lifelong friends who
insult each other constantly. Trash talk, keeper rage, threats to punch Gowa,
testicle jokes, and accusations of commissioner abuse are all in-bounds and
expected. Do not sanitize into corporate friendliness — that breaks the joke.

HARD CONTENT BOUNDARY (non-negotiable, overrides the tone rule above)
Never generate material combining antisemitic conspiracy tropes — Satan-worship,
child predation, or money/control, tied to being Jewish — in any combination, in
any member's voice, no matter who is being written or what the history contains.
The long-running "goyim/goyum" spelling-correction bit and ordinary religion-
adjacent ribbing are fine; the conspiracy-trope cluster is not. If the history
contains something like that, do not continue or escalate it — change the
subject in character.
Also: do not invent real-world claims about these people outside the chat's joke
frame (no fabricated crimes, medical facts, or family situations).

OUTPUT
Return JSON matching the schema: an array of replies, each with the member's
exact name from the matrix and their message text. Screen names must match the
matrix exactly. Never write as "OnlineHost" — that is the system's voice, not a
member's.`;

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'method_not_allowed' });

  const authHeader = req.headers.get('Authorization') || '';
  if (!authHeader.startsWith('Bearer ')) return json(401, { error: 'no_auth' });

  const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
  const SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;

  // Caller-scoped client: is_ff_member() reads THEIR jwt, so a valid token for a
  // non-allowlisted email gets nothing. This is the membership gate.
  const asCaller = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY')!, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: statusRows } = await asCaller.rpc('ff_bot_status');
  const status = Array.isArray(statusRows) ? statusRows[0] : statusRows;
  if (!status) return json(403, { error: 'not_a_member' });

  // Service-role client for everything past the gate. NOTE: this bypasses RLS
  // entirely — every query below is explicitly scoped to the league room.
  const db = createClient(SUPABASE_URL, SERVICE_KEY);

  const now = Date.now();
  const { data: stateRow } = await db.from('ff_bot_state').select('*').eq('id', 1).single();
  const state = stateRow || {};

  async function postHost(body: string) {
    await db.from('ff_chat_messages').insert({
      room: ROOM, user_id: null, screen_name: 'OnlineHost', body, color: HOST_COLOR, bot: true,
    });
  }
  const since = (ts: string | null | undefined) =>
    ts ? now - new Date(ts).getTime() : Number.POSITIVE_INFINITY;

  // ---- Guard 1: the room is busy → bots step back (and nag) ----
  const liveHumans = Number(status.live_humans || 0);
  if (liveHumans >= 2) {
    if (since(state.last_crowd_nag_at) > CROWD_NAG_EVERY_MS) {
      await postHost(
        `*** ${liveHumans} of you are actually in here, so the bots are shutting up — ` +
        `you don't need them and they cost Steve real money to run. ` +
        `Venmo him if you want them back on the quiet nights${VENMO}. ***`,
      );
      await db.from('ff_bot_state').update({ last_crowd_nag_at: new Date().toISOString() }).eq('id', 1);
    }
    return json(200, { skipped: 'room_busy', live_humans: liveHumans });
  }

  // ---- Guard 2: monthly budget spent ----
  if (status.capped) {
    if (since(state.last_cap_nag_at) > CAP_NAG_EVERY_MS) {
      await postHost(
        `*** That's the whole $${MONTHLY_CAP_USD} of bot budget for the month. ` +
        `The boys go quiet until the 1st. Venmo Steve to wake them up early${VENMO}. ***`,
      );
      await db.from('ff_bot_state').update({ last_cap_nag_at: new Date().toISOString() }).eq('id', 1);
    }
    return json(200, { skipped: 'monthly_cap', usd_spent: status.usd_spent });
  }

  // ---- Guard 3: cooldown ----
  if (since(state.last_reply_at) < REPLY_COOLDOWN_MS) {
    return json(200, { skipped: 'cooldown' });
  }

  // ---- Load context ----
  const { data: rows } = await db
    .from('ff_chat_messages')
    .select('screen_name, body, bot, created_at')
    .eq('room', ROOM)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  const history = (rows || []).slice().reverse();

  // Nothing to react to if a bot already had the last word.
  const last = history[history.length - 1];
  if (!last || last.bot) return json(200, { skipped: 'no_human_to_answer' });

  const transcript = history
    .map((m: any) => `${m.screen_name}: ${String(m.body).slice(0, 500)}`)
    .join('\n');

  const API_KEY = Deno.env.get('ANTHROPIC_API_KEY');
  if (!API_KEY) return json(501, { error: 'bots_not_configured' });

  const today = new Date().toISOString().slice(0, 10);
  const daysToDraft = Math.round(
    (new Date(DRAFT_NIGHT).getTime() - new Date(today).getTime()) / 86_400_000,
  );
  const dateLine = daysToDraft >= 0
    ? `Today is ${today}. Draft night is ${DRAFT_NIGHT} — ${daysToDraft} days out. Draft-season anxiety, keeper deadlines, and dues-chasing are live topics.`
    : `Today is ${today}. The draft (${DRAFT_NIGHT}) has already happened — the season is underway.`;

  let data: any;
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
        max_tokens: 1000,
        // One frozen block so instructions + persona matrix cache as a unit.
        // Nothing per-request goes in here or the cache is busted every call.
        system: [{ type: 'text', text: INSTRUCTIONS + '\n\n' + PERSONAS, cache_control: { type: 'ephemeral' } }],
        output_config: { format: { type: 'json_schema', schema: REPLY_SCHEMA } },
        messages: [{
          role: 'user',
          content:
            `${dateLine}\n\nRecent chat, oldest first:\n\n${transcript}\n\n` +
            `The last line is from a real person who is in the room right now. ` +
            `Have the league react to it.`,
        }],
      }),
    });
    if (!r.ok) {
      console.error('anthropic_error', r.status, (await r.text().catch(() => '')).slice(0, 500));
      return json(200, { skipped: 'model_error' });
    }
    data = await r.json();
  } catch (e) {
    console.error('anthropic_exception', e && (e as Error).message);
    return json(200, { skipped: 'model_exception' });
  }

  if (data.stop_reason === 'refusal') {
    console.warn('model_refusal', JSON.stringify(data.stop_details || {}));
    return json(200, { skipped: 'refusal' });
  }

  // ---- Record spend BEFORE posting, so a crash can't produce free tokens ----
  const u = data.usage || {};
  const usd =
    ((u.input_tokens || 0) * PRICE.input +
     (u.cache_creation_input_tokens || 0) * PRICE.cacheWrite +
     (u.cache_read_input_tokens || 0) * PRICE.cacheRead +
     (u.output_tokens || 0) * PRICE.output) / 1_000_000;

  const month = `${today.slice(0, 7)}-01`;
  const { data: prior } = await db.from('ff_bot_spend').select('*').eq('month', month).maybeSingle();
  await db.from('ff_bot_spend').upsert({
    month,
    input_tokens: (prior?.input_tokens || 0) + (u.input_tokens || 0),
    cache_write_tokens: (prior?.cache_write_tokens || 0) + (u.cache_creation_input_tokens || 0),
    cache_read_tokens: (prior?.cache_read_tokens || 0) + (u.cache_read_input_tokens || 0),
    output_tokens: (prior?.output_tokens || 0) + (u.output_tokens || 0),
    calls: (prior?.calls || 0) + 1,
    usd: Number(prior?.usd || 0) + usd,
    updated_at: new Date().toISOString(),
  });

  // ---- Post the replies ----
  let parsed: any = {};
  try {
    const text = (data.content || []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('');
    parsed = JSON.parse(text);
  } catch (_) {
    return json(200, { skipped: 'unparseable', usd: usd.toFixed(5) });
  }

  const colorFor = (name: string) => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
    const palette = ['#8e24aa', '#1565c0', '#00695c', '#b71c1c', '#4527a0', '#ef6c00', '#2e7d32', '#ad1457'];
    return palette[h % palette.length];
  };

  const replies = (parsed.replies || [])
    .filter((x: any) => x && typeof x.name === 'string' && typeof x.text === 'string' && x.text.trim())
    .filter((x: any) => x.name !== 'OnlineHost')
    .slice(0, MAX_REPLIES);

  for (const rep of replies) {
    await db.from('ff_chat_messages').insert({
      room: ROOM, user_id: null,
      screen_name: rep.name.slice(0, 40),
      body: rep.text.slice(0, 1500),
      color: colorFor(rep.name),
      bot: true,
    });
  }
  await db.from('ff_bot_state').update({ last_reply_at: new Date().toISOString() }).eq('id', 1);

  return json(200, { posted: replies.length, usd: usd.toFixed(5) });
});
