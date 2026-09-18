# 4. Suggested Output Schema

Populate this after each conversation (fields can be null/"unclear" where not established):

```json
{
  "attempt_status": "first_timer | repeater | unclear",
  "repeater_detail": "e.g. 2nd attempt, cleared G1 pending G2 — free text or null",
  "target_attempt": "jan_27 | gave_sep_26 | other_month | unclear",
  "target_attempt_detail": "free text, e.g. 'targeting May 27' if other_month",
  "groups": "g1 | g2 | both | unclear",
  "performance_level": "easy | medium | hard | unassessed",
  "performance_confidence": "quiz_verified | self_reported | unassessed",
  "preparation_level": "good | average | poor | unclear",
  "preparation_signals": ["short phrases or reasons behind the rating"],
  "inconsistent_signal": false,
  "notes": "anything else worth flagging for a human reviewer"
}
```
