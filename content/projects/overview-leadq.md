---
id: overview-leadq
name: LeadQ Overview V2
server: srv1340120
status: live
url: Analytical dashboard over Yamini
order: 3
tags: [FastAPI, MongoDB, Google Sign-In, leadership]
summary: Summary dashboard above LeadQ. Aggregated KPIs, funnel snapshots and project-wise performance for leadership and strategy reviews, read straight from the local Yamini database.
stats:
  - { value: "$mongo.Yamini.customerChats.docs", label: "Records read" }
  - { value: "8002", label: "Port" }
  - { value: "Local", label: "Database", state: live }
services: [dashboard2]
updated: 2026-08-24
---

## Flow

```flow
node    leaders "Leadership"    "strategy reviews"
node    google  "Google Sign-In" "24h JWT"              live
node    nginx   "nginx"         "overview.leadq.co.in"  live
node    app     "dashboard2"    "uvicorn :8002"         live
store   db      "Local MongoDB" "Yamini"
node    api     "REST API"      "/api/stats, /api/leads" live

edge leaders -> google live
edge google  -> nginx  live
edge nginx   -> app    live
edge app     -> api    live
edge api     -> db     data
```

## What it shows

Overview (stat cards, intent doughnut, confidence spread, template campaigns,
qualification funnel), All Leads (paginated 25 per page, filtered by type,
intent and qualification, searchable by phone), a detail drawer showing templates
sent and the full conversation as bubbles with the AI verdict, and an Analysis
page with qualification-rate and intent breakdowns.

| Endpoint | Returns |
|---|---|
| `GET /api/stats` | Aggregate counters for the stat cards |
| `GET /api/leads` | Paginated lead list |
| `GET /api/lead/{session}` | One conversation with its verdict |
| `GET /api/export/qualified` | Qualified leads export |

Filters: `doc_type`, `intent`, `qualified`, `search`, `min_confidence`,
`max_confidence`, `page`, `limit`.

## Why this one is trustworthy

It reads the same local database Yamini writes to, so its numbers are the live
ones. When this dashboard and LeadQ disagree, this is the side backed by the
data the agent actually produced. See [LeadQ](#project=leadq) for the split-brain
question.

## Served over TLS with no certificate of its own

nginx terminates TLS for `overview.leadq.co.in`, but certbot holds no
certificate covering that hostname. The `leadq.co.in` certificate covers the
apex, `www` and `hrportal` only. Worth checking what it is actually presenting.
