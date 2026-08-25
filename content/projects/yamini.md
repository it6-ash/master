---
id: yamini
name: Yamini
server: srv1340120
status: partial
url: WhatsApp lead qualification agent
order: 1
tags: [n8n, MongoDB, GPT-5 mini, WhatsApp Cloud API, Delhi 6, Blue Pearl]
summary: n8n AI agent that talks to inbound WhatsApp leads for KW Delhi 6 and KW Blue Pearl, qualifies them on budget and intent, and stores every conversation in MongoDB.
stats:
  - { value: "$mongo.Yamini.customerChats.docs", label: "Conversations" }
  - { value: "504",   label: "Analysed" }
  - { value: "₹0.59", label: "Cost per lead" }
  - { value: "0",     label: "Reached CRM", state: broken }
workflows: [zNyAPupAI9GE1UYX, bd8s6I7ahQnw7kbs, Sxy3kN781MAZw71n, 1OmPVKibN1EwKRCCLEb9G, QOxVyLRx80QNkKfS, dSPTj5H7hK4vSulG, ppXd4bTAUtLaBwB7, zKgpO4-u-yu_-aVSCRgEj]
services: [n8n-n8n-1, mongod]
updated: 2026-08-24
---

> **Status correction.** Yamini is **running**, not parked. The "PARKED, we're doing
> Meta first" banner belongs to the *Google Ads conversion-signal project*
> (Customer Match + Enhanced Conversions), which is a separate programme. What is
> broken inside Yamini, the Qualification Agent and the Cratio write-back, was not
> a decision.

## Flow

```flow
node    ads    "Meta ads"        "click-to-WhatsApp"
node    ivr    "IVR"             "kw-delhi-6-ivr"
node    bcast  "Weekly broadcast" "approved templates"   live
node    meta   "Meta Cloud API"  "direct, no BSP"        live
node    router "KW WhatsApp Main" "webhook + router"     live
node    agent  "Yamini agent"    "GPT-5 mini"            live
store   db     "MongoDB"         "Yamini.customerChats"
node    qual   "Qualification"   "504 of 27,368"         broken
node    dash   "Overview V2"     "overview.leadq.co.in"  live
ext     crm    "Cratio CRM"      "4 AI Bot fields"

edge ads    -> meta   live
edge ivr    -> meta   live
edge bcast  -> meta   live
edge meta   -> router live
edge router -> agent  live
edge agent  -> meta   live   "reply, free"
edge agent  -> db     data
edge bcast  -> db     data
edge db     -> qual   data
edge qual   -> db     data
edge db     -> dash   data
edge qual   -> crm    broken "never fires"
```

## What it is

| Attribute | Value |
|---|---|
| Channel | Meta WhatsApp Cloud API, direct, no BSP |
| Product | Pre-leased commercial shops |
| Qualifies on | Approximate investment budget: ₹25-30L / ₹40-50L / above |
| Intent keywords | price, location, site visit, possession, loan, EMI |
| Memory store | MongoDB `Yamini.customerChats` on srv1340120 |
| Session key | `sessionId` = phone number, E.164 without `+` |
| Message format | LangChain `{type: "human"\|"ai", data: {content, ...}}` |
| Read-out | `overview.leadq.co.in`, FastAPI on :8002 |
| Origin | Ran on MongoDB Atlas until ~20 Apr 2026, then migrated to the VPS |

**The naming trap.** The workflow literally named `KW Group – YAMINI WhatsApp AI
Support` (`zNyAPupAI9GE1UYX`) is **inactive**. It is not the running system. The
live agents are `WhatsApp Chat Agent`, `WhatsApp D6 Inbound AI Reply` and
`WhatsApp BP Inbound AI Reply`. Do not conflate the system name with the workflow
name.

## Qualification

Records carrying a `leadAnalysed` flag get scanned for intent keywords and a
budget band, then a verdict is written back onto the same document. Records
without the flag are never queued and never processed, which is where the
~26,800 missing conversations went.

| Intent | Meaning | Qualified |
|---|---|---|
| `INTERESTED` | Clear buying intent with signals | usually `true` |
| `QUERY` | Asking questions, engaged but undecided | varies |
| `NOT_INTERESTED` | Explicit decline | `false` |
| `JUNK` | Spam or wrong number | `false` |
| `FAILED` | Conversation yielded nothing usable | `false` |

The verdict block written to each analysed document:

```json
{
  "intent":     "FAILED",
  "qualified":  false,
  "confidence": 0.05,
  "signals": ["23 repeated \"Yes\" messages", "no qualification keywords"],
  "summary": ["User sent 23 consecutive single-word affirmative replies."]
}
```

## Data model

`Yamini.customerChats` holds three shapes in one collection: `template` records
for broadcasts sent, `chat` records carrying the LangChain message array, and
the 504 `analysed` records that also carry an `output` verdict.

| Field | Type | Notes |
|---|---|---|
| `sessionId` | string | phone number, E.164 without `+` |
| `messages` | array | LangChain format |
| `messageLength` | int | turn count, and the token-cost driver |
| `leadAnalysed` | bool | present only on analysed records |
| `output` | object | intent, qualified, confidence, signals, summary |

The same database also holds `allowedUsers` (dashboard sign-in allowlist) and
`authLogs`. Agent data and dashboard auth share one database, so read access to
the allowlist is read access to every customer conversation.

## Cost

Two lines only: Meta's per-message WhatsApp fee, and OpenAI tokens. Everything
else is already paid for and shared.

| Unit of work | List price | With prompt caching |
|---|---|---|
| One 10-turn conversation | ₹0.47 | ₹0.31 |
| One qualification analysis | ₹0.12 | ₹0.11 |
| **Conversation + analysis** | **₹0.59** | **₹0.42** |
| One marketing template | ₹1.038 | ₹1.038 |
| One service reply, inside the 24h window | ₹0.00 | ₹0.00 |

Yamini's own replies are **free**: every one is a service message inside the
24-hour window the lead opened. Only outbound broadcasts are billed, and they are
roughly 85% of total spend at every volume.

Clearing the entire unanalysed backlog costs **₹1,556** via the Batch API, which
is 0.31% of one month's Google Ads spend. The skipped conversations were never a
cost decision. The job stopped running and nobody noticed.

## Inbound conversation

What happens between a lead's message and Yamini's reply. Every reply lands
inside the 24-hour customer window, which makes it a service message and free.

1. Lead sends a WhatsApp message
2. Meta POSTs the inbound webhook
3. The router identifies the project, D6 or Blue Pearl
4. It routes to the agent
5. The agent loads chat memory from MongoDB by `sessionId`
6. Prior messages come back
7. The LLM generates a reply
8. Human and AI messages are appended to `customerChats`
9. The reply goes out through Meta
10. Meta delivers it to the lead

A real exchange, session `919958926826`:

| Turn | Speaker | Content |
|---|---|---|
| 1 | Lead | Yes |
| 2 | Yamini | Great Sir, thank you for the confirmation. May I know your approx investment budget for a pre-leased commercial shop, for example ₹25-30L, ₹40-50L, or above? |

## Two dashboards, two databases

Yamini's output is read by two separate web apps on the same server. They are
siblings, they show the same kind of data, and they read from **completely
different databases**.

| | LeadQ | LeadQ Overview V2 |
|---|---|---|
| URL | `leadq.co.in` | `overview.leadq.co.in` |
| Service | `dashboard` :8001 | `dashboard2` :8002 |
| Database | **MongoDB Atlas** `whatsapp_leads2` | **Local** `Yamini` |
| Purpose | Operational, work the leads | Analytical, read the numbers |
| Receiving Yamini's writes | unknown | yes |

Nothing observed connects the local database Yamini writes to with the Atlas
one LeadQ reads. See [LeadQ](#project=leadq) for the three hypotheses and the
query that settles it.

## n8n workflow map

The workflows on `srv1340120` that make up this system. Live and off are read
from the latest ingest, not from this document.

| Workflow | Role |
|---|---|
| `KW WhatsApp — Main` | Webhook entry, routes by project |
| `KW WhatsApp — Main` | Second workflow, identical name, different id |
| `WhatsApp Chat Agent` | Live inbound agent |
| `WhatsApp D6 Inbound AI Reply` | Delhi 6 variant |
| `WhatsApp BP Inbound AI Reply` | Blue Pearl variant |
| `D6 / BP Weekly Broadcast` | Outbound approved templates |
| `Lead Qualification Agent` | Produces the verdict block |
| `KW 3 · Qualification & CRM Writeback` | **Exists, inactive.** The missing link |

## Where the leads come from

All 26,437 records, by source. Ads are the driver; IVR and broadcast are a
rounding error next to them.

| Source | Count | Share |
|---|---|---|
| Meta ads, GBT_whatsapp D6 + BP | 24,417 | 92.4% |
| IVR, kw-delhi-6-ivr-whatsapp | 1,441 | 5.5% |
| Weekly broadcast templates | 579 | 2.2% |
| **Total** | **26,437** | **100%** |

## Parked versus broken

An important distinction, and the reason the status banner at the top of this
page exists.

**Deliberately parked**, a decision somebody took: Google Customer Match and
Google Enhanced Conversions. Files built, tested, waiting. The reason was
"doing Meta first".

**Silently broken**, no decision taken: the Qualification Agent running on 504
of ~26,000 records, and the Cratio write-back that has never fired. Nobody
chose to skip 25,933 conversations. The job stopped and went unnoticed.

## Runbook

What to do now, in order.

1. **Get the real funnel and cost inputs.** Query `customerChats` for total,
   analysed, qualified, distinct `sessionId`, and the average `messageLength`.
   Turn count scales token cost linearly and is currently assumed, not measured.
2. **Turn on prompt caching and check reply length.** The system prompt is
   byte-identical on every turn, which is the textbook caching case and worth
   34%. Output tokens cost 8x input, so shorter replies are the other lever.
3. **Settle the split-brain.** Compare the newest document timestamp in the
   local database and in Atlas. That single number picks the hypothesis.
4. **Backfill the analysis.** ₹1,556 via the Batch API clears every unanalysed
   conversation. This was never a budget decision.
5. **Build the Cratio write-back**, or activate the workflow that already
   exists for it.

## Where Yamini sits in the estate

| Server | Role | What runs |
|---|---|---|
| `srv1340120` | Apps and automation | n8n, MongoDB, the FastAPI read-outs. Yamini lives here |
| `srv1900820` | Websites | Three production sites, no part of Yamini |
| `srv1870078` | Second n8n | Idle. Three workflows, one active, none of them Yamini |

## Open questions

Two inputs to the cost model are still estimated. Average `messageLength` scales
cost linearly and the sample conversation ran to 23 turns, so real cost could be
roughly double. Whether prompt caching is enabled in the n8n LLM node is
unverified, and turning it on is a 34% saving for no behavioural change.
