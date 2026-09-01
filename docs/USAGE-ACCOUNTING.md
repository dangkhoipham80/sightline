# Counting tokens from transcripts

> Measured against both `~/.claude` stores on the reference machine: 142 sessions,
> 57,073 `assistant` records, Claude Code `2.1.198` and `2.1.238`–`2.1.241`.

Sightline's usage meter exists to answer "how much have I spent, and how close am I to a
limit". A meter that is confidently wrong is worse than no meter, so this document records
what the numbers mean and how they are derived. The rule the rest of the feature is built
on: **never show a number we cannot defend.**

---

## The unit is the API response, not the record

This is the whole ballgame, and getting it wrong is the default.

Claude Code writes **one `assistant` record per content block**. A response containing a
`thinking` block followed by a `tool_use` block is two records — and *both* carry the same
`message.usage`:

```
line 4  assistant  stop=null       blocks=[thinking]  in=3 out=8   cache_read=9633 cache_write=5955
line 5  assistant  stop="tool_use" blocks=[tool_use]  in=3 out=144 cache_read=9633 cache_write=5955
```

One API call. One bill. Two records.

| | |
| --- | ---: |
| `assistant` records | 57,073 |
| distinct `message.id` | 29,428 |
| ids written as one record | 13,527 |
| ids written as several, usage **identical** | 13,361 |
| ids written as several, `output_tokens` **grows** | 3,019 |

So: group by `message.id`. Within a group, `input_tokens`, `cache_read_input_tokens` and
`cache_creation_input_tokens` are constant while `output_tokens` grows as the response
streams — **verified monotonic across all 16,004 multi-record groups, zero decreases**. The
last record of a group therefore carries the complete figure, and it is the one to keep.

Summing per record instead inflated our corpus by **2.408×** on `input + output`.

## Deduplication has to be global

**476 `message.id`s appear in more than one transcript file.** Resuming a session copies
earlier turns into the new file, so the same API call is on disk twice, in two sessions.

That is why `token_events` is unique on `(session_id, dedupe_key)` and **not** globally:
`writeSession` is delete-then-insert per session, so a global unique constraint would let
whichever session was ingested first own the row — and then vaporise it when *that* session
is re-ingested, silently deleting spend still attributable to the other one.

Dedupe globally at **query** time instead. Worth 1.9% on this corpus.

## Subagent spend is session spend

Sidechain work lives under `<session>/subagents/`, and its tokens are as real as any
other. 45 of 142 sessions here have subagent files. A session that delegates heavily
spends *most* of its tokens there, so a total drawn from the main transcript alone reports
near-zero for exactly the sessions that cost the most.

**They are not all in one directory.** `Task`-spawned agents sit directly in `subagents/`;
agents spawned by the Workflow tool are nested a level deeper, in
`subagents/workflows/wf_<id>/agent-*.jsonl`. A top-level-only read finds the first group
and none of the second.

Measured over both stores on the reference machine — 137 sessions, 2026-09-01, immediately
before and after the loader learned to descend:

| | flat read | recursive read | |
| --- | ---: | ---: | ---: |
| subagent transcripts | 206 | 386 | +180 |
| token events | 29,074 | 33,608 | +4,534 |
| input | 4,982,327 | 5,454,658 | +9.5% |
| output | 23,449,637 | 26,553,339 | +13.2% |
| cache read | 6,690,894,224 | 6,982,333,716 | +4.4% |
| cache write | 90,124,064 | 101,112,930 | +12.2% |

The corpus-wide percentages are the least interesting row here, because the error is not
spread evenly. Only **3 of 137** sessions used a workflow at all — and in those three, the
missing sidechains were most of the session:

| Session | agents recovered | output before | after | share that was missing |
| --- | ---: | ---: | ---: | ---: |
| `4ef1c11d…` | 135 | 221,781 | 2,810,387 | **92.1%** |
| `a7809caa…` | 22 | 46,365 | 310,355 | 85.1% |
| `a760a316…` | 23 | 95,198 | 346,304 | 72.5% |

A meter that reports 8% of a session's real cost is worse than one that reports nothing,
because 221,781 is a plausible number. This is the same failure as counting per record
rather than per response: it produces an answer, and the answer is confident.

Two consequences worth keeping. The loader selects sidechains by the `agent-*.jsonl`
filename at any depth rather than by looking for a `workflows/` directory — the filename is
also what excludes the Workflow tool's own `journal.jsonl`, which is not a transcript. And
because the incremental check compares only the *main* transcript's size and mtime, finding
files that were always on disk changes nothing it looks at; reaching an existing index took
a `SIGHTLINE_SCHEMA_VERSION` bump.

## What the correction was worth

Old = sum every `assistant` record, main transcript only. New = one event per response,
subagents folded in.

| | input | output | cache read | cache write |
| --- | ---: | ---: | ---: | ---: |
| Old | 10,785,998 | 43,271,336 | 11,514,242,444 | 163,909,866 |
| New | 5,062,377 | 24,200,553 | 6,871,509,490 | 91,187,507 |
| New, globally deduped | 5,015,064 | 23,816,910 | 6,744,566,327 | 89,546,517 |

Cache reads were overstated by **4.6 billion tokens**. Note the ratios understate the
per-record bug on its own, because the "new" column simultaneously *adds* subagent spend
the old one never counted — two errors in opposite directions, which is the reason neither
was obvious.

Both columns predate the recursive sidechain read, so both are missing workflow spend. The
table above is a like-for-like comparison of the per-response correction alone; the
workflow delta is measured separately in the section before this one.

## Cache writes are not one price

`usage.cache_creation` splits the write into `ephemeral_5m_input_tokens` and
`ephemeral_1h_input_tokens` — present on all 57,073 records. The two TTLs bill differently
(a 1-hour write costs roughly twice a 5-minute one), so the flat
`cache_creation_input_tokens` total is not enough to cost a session.

When the breakdown is missing, everything is attributed to the cheaper 5-minute bucket.
Guessing upward would mean claiming a cost we cannot know.

## What is deliberately excluded

- `model: "<synthetic>"` — Claude Code's own status and error messages. 68 in the corpus,
  never billed by anyone.
- Records with no `usage` at all.

## What tokens still cannot tell you

**Tokens are not a percentage of a limit.** The denominator is unknowable from disk: rate
limits are per-account and Anthropic publishes only relative multipliers. Any "N tokens
remaining" figure derived from transcripts is invented. Percentages come from
`rate_limits` in the statusLine payload or they do not come at all.

---

## The confidence ladder

Every number the meter shows is labelled with where it came from, because the three cases
render identically and are not remotely equivalent.

| Rung | Source | What may be shown |
| --- | --- | --- |
| `official` | `rate_limits` captured from a statusLine hook | a percentage, its reset time, and **the age of the capture** |
| `local_estimate` | tokens from the JSONL, bucketed into a five-hour block | token counts; a cost **only** if the user supplied prices |
| `unknown` | nothing for this window | `—` |

Three rules follow from it, and all three are the kind that get "simplified" away later:

1. **`unknown` renders as an em dash, never `0`.** Zero is a measurement — it says "you
   have used nothing" — and it is the wrong answer to "we have not been told".
2. **A `local_estimate` gets no progress bar and no percentage.** A bar implies a fraction
   of something, and the something is exactly what cannot be known.
3. **The age of an `official` reading is shown.** It only refreshes while a terminal with
   the hook installed renders its status line, so it can be hours stale while looking
   perfectly live. A percentage without its age is a number pretending to be current.

The five-hour block itself is a *reconstruction*. Anthropic does not write the window
boundary anywhere; we open a block at the first event and close it five hours later, or
after an idle gap longer than the window. A boundary an hour out produces a number that
looks exactly as authoritative as a correct one — which is why everything derived from it
sits on the `local_estimate` rung and says so.

## Turning on the official numbers

The percentages exist only inside the statusLine hook payload. They are never written to
disk and there is no `claude usage --json` on any version we have seen.

```bash
sightline statusline --install   # prints a snippet; paste it yourself
```

**Sightline does not write `~/.claude/settings.json`.** Rule 2 in `CLAUDE.md` has no
exception for convenience, and this feature is the one with a real motive to want one. The
command prints the snippet and stops. Without it the meter still works — it just has no
`official` rung to show.

Captures are appended to `~/.sightline/rate-limits.jsonl`, not to the index: the hook runs
on every status-line render, and opening SQLite on that path would contend with a running
scan for no benefit.

`used_percentage` is validated rather than trusted. Claude Code has been observed leaking a
Unix epoch into it ([#52326](https://github.com/anthropics/claude-code/issues/52326)); a
value above 101 is **dropped, not clamped**, because clamping 1.7 billion to 100 would
display "you are at your limit", a far more alarming lie than showing nothing.

## Prices

`~/.sightline/pricing.json`, optional, keyed by `message.model`:

```json
{ "claude-opus-5": { "input": 5, "output": 25, "cacheRead": 0.5,
                     "cacheWrite5m": 6.25, "cacheWrite1h": 10 } }
```

Rates are USD per million tokens. **The repository ships no prices** — they change without
notice, and a stale table is indistinguishable from a current one once it has been rendered
as a dollar figure. No file means tokens only, and no cost line at all. A model present in
the usage but absent from the file is *named* in the tooltip rather than skipped, so a
partial total is never presented as a whole one.

Hour limits from 2025 are deliberately not hardcoded anywhere: they have been superseded,
and Anthropic now publishes only relative multipliers.
