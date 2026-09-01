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

Sidechain work lives in `<session>/subagents/agent-*.jsonl`, and its tokens are as real as
any other. 45 of 142 sessions here have subagent files. A session that delegates heavily
spends *most* of its tokens there, so a total drawn from the main transcript alone reports
near-zero for exactly the sessions that cost the most.

> Known gap: workflow-spawned agents live one level deeper, at
> `subagents/workflows/wf_<id>/agent-*.jsonl` — 135 transcripts on this machine — and the
> ingest glob does not reach them yet. Their tokens are therefore still missing. Tracked
> separately; the accounting above is correct for everything ingest actually loads.

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
`rate_limits` in the statusLine payload or they do not come at all — see the confidence
ladder in the usage meter.
