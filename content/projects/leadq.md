---
id: leadq
name: LeadQ
server: srv1340120
status: partial
url: Operational lead dashboard
order: 2
tags: [FastAPI, MongoDB Atlas, sales floor]
summary: The operational dashboard where the sales floor works the leads. Capture, assignment, stage tracking, agent activity logs and reporting across all KW projects.
stats:
  - { value: "8001", label: "Port" }
  - { value: "Atlas", label: "Database", state: broken }
  - { value: "2", label: "Failed units", state: broken }
services: [dashboard]
updated: 2026-08-24
---

## Flow

```flow
node    users  "Sales floor"   "telecallers"
node    nginx  "nginx"         "leadq.co.in"            live
node    app    "dashboard"     "uvicorn :8001"          live
node    dead   "fastapi_app"   "gunicorn :8001"         broken
store   atlas  "MongoDB Atlas" "whatsapp_leads2"
store   local  "Local MongoDB" "Yamini.customerChats"
node    yamini "Yamini agent"  "writes conversations"   live

edge users  -> nginx live
edge nginx  -> app   live
edge app    -> atlas data
edge yamini -> local data
edge local  -> atlas broken "no link observed"
edge dead   -> atlas idle
```

## The split-brain

This is the unresolved question in the estate, and it matters more than anything
else on this page.

Yamini writes to the **local** MongoDB, `Yamini.customerChats`, on srv1340120.
LeadQ reads from **MongoDB Atlas**, `whatsapp_leads2` on a separate cluster.
Nothing observed so far connects the two.

| | LeadQ | LeadQ Overview V2 |
|---|---|---|
| Role | Operational, work the leads | Analytical, read the numbers |
| Audience | Sales floor, telecallers | Leadership, strategy |
| Service | `dashboard.service` :8001 | `dashboard2.service` :8002 |
| Code | `/var/www/Lead-Qualification-Agent-Dashboard` | `/var/www/Dashborad_Overview` |
| Database | **Atlas** `whatsapp_leads2` | **Local** `Yamini` |
| Auth | Not inspected | Google Sign-In + 24h JWT |

Three hypotheses, and one query settles it:

1. **Atlas is frozen.** Yamini ran on Atlas until ~20 Apr 2026 then migrated to
   the VPS, and `atlas-backup/Yamini/customerChats.bson` exists on disk. If so,
   the operational dashboard has served four-month-old data since April.
2. **Atlas is still live.** A second pipeline still writes to `whatsapp_leads2`,
   two datasets diverge daily, and two dashboards report different numbers for
   the same agent without either side knowing.
3. **Different scope.** `whatsapp_leads2` holds an older bot or another project
   entirely, and the two were never meant to match.

Compare the newest document timestamp in each database. If the Atlas side stops
before ~20 Apr 2026 it is hypothesis 1. If it is within days, it is hypothesis 2
and it is urgent. The trailing "2" in `whatsapp_leads2` also implies a v1 exists,
so the cluster may hold several generations.

## Two units, one port

`dashboard.service` (uvicorn) and `fastapi_app.service` (gunicorn) both target
port 8001 from the same working directory. Only uvicorn is running.
`fastapi_app` is enabled and **failed**, which is one of the two failed units on
this host. It is almost certainly a superseded deployment that was never
disabled, but it will keep failing on every boot until someone decides.

## Credentials

The Atlas connection string is hardcoded in `config.py` and the account belongs
to a departed employee, with the username reused as the password. Values are not
reproduced here. Rotate in Atlas first, then update the config and restart the
unit. Treat every credential on this host as compromised until rotated.
