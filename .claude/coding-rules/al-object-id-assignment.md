---
paths:
  - "**/*.al"
---

# AL Object IDs

Never pick, guess or scan for an object ID. The al-object-id-ninja MCP is the only source, so parallel developers cannot collide.

## Assign (before creating any object, field or enum value)
`mcp__al-object-id-ninja__ninja_assignObjectId`
- `objectType`: `table`, `page`, `codeunit`, `enum`, `interface`, `report`, `query`, `xmlport`, `tableextension`, `pageextension`, `enumextension`, `permissionset`, `permissionsetextension`, ...
- Sub-object IDs: table field `table_<tableId>` (e.g. `table_71553575`), enum value `enum_<enumId>`.
- `targetFilePath`: absolute path to any file inside the target app (its `app.json` is fine). Test objects are reserved against the `*-test` app.
- `rangeName` (optional) when the app declares several ranges.

## Release (when deleting an object)
`mcp__al-object-id-ninja__ninja_unassignObjectId` with `objectType`, `objectId` and `targetFilePath`.

## Rules
- Assign at creation time, also for drafts and prototypes.
- Never reuse an ID of a deleted object unless it was released first.
- Different object types may legitimately share the same number.
- Ninja can occasionally hand out an ID already in use by uncommitted work; a compile error AL0264 means ask for another ID, not renumber by hand.
- Planning skills reserve IDs once, centrally (in `requirement-to-spec`), never inside parallel planner agents.
- Ranges and prefixes per app: /docs/al/object-ids.md.
