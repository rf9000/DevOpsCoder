---
paths:
  - "**/*.al"
---

# AL Obsoleting Released Elements

Never delete a released table field, page field, page action, page group, enum value or public procedure. Other apps, per-tenant customisations and user personalisations reference them by name; deletion fails AppSourceCop (AS0062 controls, AS0063 actions) and breaks upgrades.

## Procedure
1. Keep the element, add all three properties:
   ```al
   ObsoleteReason = 'Replaced by "New Field" field.';   // say what replaces it
   ObsoleteState = Pending;
   ObsoleteTag = '27.5';                                 // version being released now
   ```
2. Page elements also get `Visible = false;` (and an empty `OnAction` body for actions).
3. Add the replacement element next to it.
4. Move `Pending` -> `Removed` no earlier than two major versions later; delete the source only after that, per AppSource deprecation policy.

## Exempt
- Elements added in the current, unreleased development cycle.
- Test apps and `Access = Internal` objects that are not part of a public surface.

## Check before shipping
- Every obsoleted element has `ObsoleteReason`, `ObsoleteState`, `ObsoleteTag`; page elements are hidden.
- A replacement exists and the reason names it.
- Renaming a released field is a delete plus add; obsolete the old one instead.

## References
- https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/devenv-deprecation-guidelines
- https://learn.microsoft.com/dynamics365/business-central/dev-itpro/developer/analyzers/appsourcecop-as0062
