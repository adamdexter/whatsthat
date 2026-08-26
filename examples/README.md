# Example contact lists

Fictional people on reserved `555` / `+44 7700 900xxx` numbers — nobody real
can receive anything. Paste any file into **Contacts** (or load it with
`node scripts/create-sheet.js <file>` to turn it into a Google Sheet).

Each scenario shows how WhatsThat treats your columns: every column becomes a
`{{variable}}`, and the ones whose values repeat across people become
**send rules** (one-click filters). The rule is scaled to the list size —
automatic up to **max(4, 10 %)** distinct values, a one-time **question** up to
**max(8, 25 %)** — so the same file behaves sensibly whether it has 8 rows or
80. Numbers ending in `98` fail on send and `99` are "not on WhatsApp" in
mock mode (`npm run mock`), which makes the run report interesting for
screenshots.

## `dinner-party.csv` — 8 people, tiny list

| firstName | lastName | phone | dietary | plusOne | bringing |
|---|---|---|---|---|---|

- **Send rules (automatic):** `dietary` (None / Vegetarian / Vegan / Gluten-free),
  `plusOne` (Yes / No). With only 8 people, 10 % would be one value — the
  floor of 4 keeps a 4-way column usable.
- **Per-contact fields:** `bringing` is different for everyone, so it's a
  variable, not a rule.
- Try: select `plusOne = Yes` and send
  *"Hey {{firstName}} — Saturday 7pm still good? Bring your +1, and thanks for
  offering to bring {{bringing}}!"*

## `team-offsite.csv` — 20 people, the "ask me" case

| firstName | lastName | phone | email | office | department | tshirtSize | manager | attending |
|---|---|---|---|---|---|---|---|---|

- **Automatic rules:** `office` (4 values), `tshirtSize` (4), and `attending`
  — which is either `Yes` or **blank**, so the rule is *Yes* vs *(blank)*:
  "everyone who hasn't RSVP'd yet".
- **Asked once:** `department` (6 values) and `manager` (7 values) sit between
  10 % and 25 % of 20 people, so the app asks *"is this a way to choose who
  gets a message, or just information about each person?"* Answer **Send
  rule** for `department` (message a team) and **Per-contact field** for
  `manager` (you'd rather write *"…and {{manager}} will be there too"*). The
  answers are remembered.
- **Fields:** `email` and the names.
- Try: `attending = (blank)` →
  *"{{firstName}}, we still need your RSVP for the offsite — can you reply
  today? Your manager {{manager}} has the details."*

## `alumni-reunion.csv` — 40 people, scale in action

| firstName | lastName | phone | decade | classYear | chapter | membership | company |
|---|---|---|---|---|---|---|---|

- At 40 people the automatic cutoff is still 4 (10 % of 40) but the question
  cutoff rises to 10 (25 %).
- **Automatic rules:** `decade` (4), `membership` (Active / Lapsed).
- **Asked once:** `classYear` has exactly 10 values — right at the edge, so
  you decide. Say **Send rule** if you message by year, **Field** if you only
  ever use it in the text.
- **Fields:** `chapter` (14 values — too many to be a rule, though *columns…*
  lets you force it), `company` (20 values).
- Try: `membership = Lapsed` →
  *"{{firstName}}, the {{decade}} reunion is on the 14th — we'd love to see
  the class of {{classYear}} back in the room."*

## `golf-day.csv` — 12 people, numbers and international phones

| firstName | lastName | phone | preferredTee | member | handicap | homeCourse |
|---|---|---|---|---|---|---|

- **Automatic rules:** `preferredTee` (Morning / Afternoon), `member`
  (Yes / No), `homeCourse` (3 values).
- **Fields:** `handicap` — a number that's different for everyone, so it's
  a variable: *"You're off at {{preferredTee}} tee, playing off {{handicap}}."*
- UK numbers with a leading `+` are kept as-is; bare 10-digit numbers are
  treated as US.

## `contacts-sample.csv` — 14 people, the general case

| firstName | lastName | nickname | phone | email | city | rank | Status |
|---|---|---|---|---|---|---|---|

- **Automatic rules:** `rank` (Prospect / EA / FC / MM), `Status`
  (Active / Inactive).
- **Asked once:** `city` (6 values across 14 people).
- **Fields:** `nickname` (great for *"Hey {{nickname}}"*), `email`, names.
- One row has no phone number and is shown but excluded from sending.
