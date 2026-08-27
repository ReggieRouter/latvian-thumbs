// LEN-1593: single source of truth for the league's settled facts.
//
// Why this file exists: before it, nothing pinned the draft date. Each
// generation re-derived it from the last ~80 messages of history, so it
// drifted — the draft was announced as "Sunday Aug 23rd, 6 pm sharp" on
// 2026-07-27 and by 2026-08-06 the chat was saying "aug 23, 7pm". Meanwhile
// ff-bot-reply had DRAFT_NIGHT = '2026-08-27' hardcoded, a Thursday, which
// matched nothing the room had ever said.
//
// Facts below are what the room actually voted on and announced, quoted from
// ff_chat_messages. If a real-world detail changes, change it HERE — both
// edge functions import from this file, and CHAT_RULES.md §0 mirrors it for
// humans.

export const DRAFT_DATE = '2026-08-23';      // Sunday — verified, not a guess
export const DRAFT_TIME = '6:00 PM';
export const DRAFT_VENUE = "McSorley's Old Ale House, NYC";
export const KEEPER_DEADLINE = '2026-08-17';
export const DUES_AMOUNT = '$75';

// Injected verbatim into both functions' system prompts.
export const LEAGUE_CANON = `LEAGUE CANON — SETTLED FACTS (never contradict these, never re-announce them)
These were decided by a vote the room already had. They are BACKGROUND, not
material. You may assume everyone knows them.

  • Draft: Sunday, August 23rd 2026, 6:00 PM sharp, McSorley's Old Ale House NYC
  • Keeper lock deadline: August 17th 2026
  • Dues: $75, cash at the draft (Gowa is sick of Venmo fees)
  • Commissioner of record: Steve Gowa. Chris Marchesano signs off as
    "League Commissioner" as a running joke — he is not the commissioner.
  • Reigning champion: George Economou
  • 2QB referendum: DEAD. Keeper-inflation review: PASSED (Rosenheck's
    committee of one). Do not relitigate settled votes.
  • Jonathan Mootz has lost three straight finals.

USING THESE FACTS
- NEVER state the draft date, time, or venue as an announcement. It was
  announced weeks ago. A member who re-announces it sounds like a bot.
- NEVER change the time, venue, or date to something else. If the recent
  history you were given contradicts this block, THIS BLOCK WINS — the history
  has drifted and you must not follow it.
- Do not compute "the draft is in N days" and put the number in a message. It
  is a reliable way to be wrong and it is not interesting.
- These facts may only ever appear as an offhand aside inside a message about
  something else, and they count against the topic budget when they do.`;
