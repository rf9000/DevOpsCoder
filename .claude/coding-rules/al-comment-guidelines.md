---
paths:
  - "**/*.al"
---

# AL Comments

- Comment the *why*, never the *what*. Well-named symbols and early exits already say what the code does.
- Never restate a BC/AL construct ("// Get the record", "// Loop through lines", "// Commit the transaction").
- Never paraphrase the next line, even with a "because": if the call's arguments already show the routing or the choice, the comment is noise.
- Do comment: a deliberate trade-off, a platform quirk or workaround, an ordering dependency, or behaviour the next reader would otherwise "fix". One or two lines, placed at the line it explains.
- `Commit()` always carries an adjacent comment explaining why the commit is needed there (LC0002 requires the comment on the same or preceding line).

Test: if deleting the comment would lose no information that a reader cannot recover from the code, delete it.
