# 3. Classification Dimensions

## 3.1 First-timer vs Repeater

**Definition:** Is this the student's first attempt at CA Intermediate (either group), or have
they already appeared before (regardless of result)?

**Signals — Repeater:**

- States a past attempt month/year ("I wrote G1 in May 25", "already gave inter G1 and cleared")
- Mentions a **carried-forward exemption** in a specific paper (scored 60+ before)
- Says things like "2nd attempt", "repeating", "re-attempt", "failed last time", "cleared G1 but
  not G2"
- References receiving a past result, rank letter, marks memo

**Signals — First-timer:**

- Just finished/cleared CA Foundation and is starting Inter for the first time
- Says "first attempt", "puthusa" (Tanglish for "newly"), "starting Inter now"
- No mention of any past CA Inter sitting

**Fallback:** If neither signal is present, mark unclear — do not assume first-timer by default,
since repeaters are the more common WhatsApp responder profile for FOCAS Edu's re-engagement and
"Last Attempt" audiences. Ask directly if it materially changes the conversation ("Is this your
first Inter attempt or a repeat attempt?").

## 3.2 Target Attempt: Jan 27 vs Gave Sep 26

**Signals — targeting Jan 27 (forward-looking):**

- Future/continuous tense: "preparing for", "planning to write", "syllabus is left", "classes are
  going on"
- Asks about the Jan exam date, registration, or upcoming test series
- Talks about topics still to cover

**Signals — gave Sep 26 (past, just written):**

- Past tense: "exam got over", "I wrote it", "paper was tough", "waiting for results"
- References specific Sep paper dates or post-exam stress/relief
- Asks "what next after Sep result" or about revaluation/next steps

**Note:** these two are not mutually exclusive across time — a student can have **just given
Sep 26 and now be starting prep for Jan 27** (common repeater pattern, e.g. gave only G1 in Sep
and now prepping G2 for Jan, or re-attempting a failed group). Capture both flags if both are
stated rather than forcing one.

## 3.3 Groups: G1 / G2 / Both

**Signals:**

- Direct: "I'm doing both groups", "only Group 1", "G2 mattum" (Tanglish "only G2")
- Indirect via subject names — map through the
  [Section 1 table](01-ca-intermediate-primer.md) (e.g., mentions Accounts + Law + Tax → G1;
  mentions Costing + Audit + FM/SM → G2; mentions subjects from both lists → Both)
- Repeaters often mention **one already-cleared group** plus one pending group — classify by what
  they're **currently preparing/appearing for**, not what they've already cleared, unless the
  question is about attempt history.

**Fallback:** unclear if no subject or group is named at all.

## 3.4 Performance Level: Easy / Medium / Hard

**Definition:** The highest difficulty tier at which the student is reliably answering correctly —
i.e., can they only manage easy/direct questions, do they hold up through medium-difficulty
application questions, or can they handle hard/practical, multi-concept problems. This mirrors
FOCAS's existing Easy→Hard difficulty tagging used in the Last Attempt Kit question banks, so it's
meant to slot into that same tiering.

**Preferred source — a short mixed-difficulty check:** if, and only if, the conversation includes
or can include a small diagnostic (a few tagged Easy, Medium, and Hard questions per subject),
classify performance level as the **highest tier where the student clears a reasonable accuracy
bar** (e.g., ~70%+ correct). Mark `performance_confidence: quiz_verified` when this is the source.
If not, go to fallback.

**Fallback — self-reported/conversational signals** (mark `performance_confidence: self_reported`,
which is less reliable and should be weighted lower):

- Easy-only: "I can do basic/theory questions but blank out on practicals", "struggling even with
  simple problems"
- Medium: "I'm okay with standard questions but the twisted/application ones trip me up"
- Hard: "I can handle even the tricky practical problems", "confident with case-study/mixed-concept
  questions", strong scores mentioned in mocks/tests

**Do not infer this dimension from preparation-level language alone** (e.g., "I study 6 hours a
day" is a preparation signal, not a performance signal) — they are related but distinct and should
be extracted separately.

## 3.5 Preparation Level: Good / Average / Poor

**Signals — Good:**

- Regular, specific study routine (daily hours, subject-wise plan, tracker)
- Syllabus mostly/fully covered, revision underway
- Attending classes/mock tests consistently, decent recent test scores
- Confident, low-anxiety tone

**Signals — Average:**

- Partial syllabus coverage, some chapters pending
- Inconsistent study habits ("some days I study, some days I don't")
- Moderate confidence with specific named weak areas
- Mixed sentiment — neither confident nor panicked

**Signals — Poor:**

- Large syllabus gaps, "just started", missed most classes
- High-anxiety or hopeless language ("I don't think I'll clear this time", "too much left, can't
  cover")
- Asking for shortcuts, "fastest way to pass", crash-course requests
- Long gap since last serious study session

**Cross-check:** if preparation level and performance level strongly disagree (e.g., self-reports
"good preparation" but fails easy-tier questions in a diagnostic, or vice versa), flag
`inconsistent_signal: true` rather than silently picking one — this is useful for a human
reviewer, especially for repeaters who may be overconfident from having "seen the syllabus
before."
