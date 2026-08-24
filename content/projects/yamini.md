---
id: yamini
name: Yamini
server: srv1340120
status: partial          # live | partial | broken | idle
url: WhatsApp AI · n8n + MongoDB
tags: [n8n, MongoDB, GPT-5 mini, WhatsApp Cloud API]
summary: WhatsApp agent that qualifies inbound leads for Delhi 6 and Blue Pearl.
stats:
  - { value: "26,437", label: "Records" }
  - { value: "504",    label: "Analysed" }
  - { value: "₹0.59",  label: "Per lead" }
  - { value: "0",      label: "To CRM", state: broken }
workflows: [zNyAPupAI9GE1UYX, bd8s6I7ahQnw7kbs, Sxy3kN781MAZw71n]
services: [n8n-n8n-1, mongod]
---

## Flow

```flow
node    lead   "Lead"           "click-to-WA ads"
node    meta   "Meta Cloud API" "webhook"              live
node    n8n    "n8n router"     "KW WhatsApp Main"     live
node    agent  "AI Agent"       "GPT-5 mini"           live
store   db     "MongoDB"        "Yamini.customerChats"
node    qual   "Qualification"  "504 of 26,437"        broken
node    dash   "Overview dash"  "leadq.co.in"          live
ext     crm    "Cratio CRM"     "AI Bot fields"

edge lead  -> meta   live
edge meta  -> n8n    live
edge n8n   -> agent  live
edge agent -> db     data
edge db    -> qual   data
edge qual  -> db     data
edge db    -> dash   data
edge qual  -> crm    broken  "never fires"
```

## Detail

Inbound leads arrive from click-to-WhatsApp ads, hit the Meta Cloud API webhook,
and are routed by n8n into a GPT-5 mini agent. Every conversation is persisted to
`Yamini.customerChats` on srv1340120. The overview dashboard reads straight from
that collection.

The qualification step is where it breaks. 504 of 26,437 records carry a verdict,
and none of those verdicts are pushed to Cratio — the four `AI Bot` fields on the
CRM record have been null since Aug 2025.

**Naming trap.** The n8n workflow literally named `KW Group – YAMINI WhatsApp AI
Support` is **inactive**. It is not the running system. The live agents are
`WhatsApp Chat Agent`, `WhatsApp D6 Inbound AI Reply` and `WhatsApp BP Inbound AI
Reply`. Do not conflate the system name with the workflow name.

## Issues

Issues live in `data/issues.json`, not here — they are cross-referenced by
`project: yamini`.
