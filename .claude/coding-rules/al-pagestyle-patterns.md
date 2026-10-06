---
paths:
  - "**/*.al"
---

# AL PageStyle

- `PageStyle` is a datatype, not an enum: `MyStyle: PageStyle;`, never `Enum PageStyle`.
- `StyleExpr` accepts only a `Text` variable (or field). Compute the `PageStyle` in a procedure and store `Format(PageStyle::Favorable)` in a page-global `Text` assigned in `OnAfterGetRecord`.
- Never use string literals such as `'Favorable'`; they trigger CodeCop and lose IntelliSense.

```al
field(Status; Rec.Status) { StyleExpr = StatusStyleTxt; }

var
    StatusStyleTxt: Text;

trigger OnAfterGetRecord()
begin
    StatusStyleTxt := Format(GetStatusStyle(Rec.Status));
end;

local procedure GetStatusStyle(Status: Enum "My Status"): PageStyle
begin
    case Status of
        Status::Approved:
            exit(PageStyle::Favorable);
        Status::Rejected:
            exit(PageStyle::Unfavorable);
        Status::Pending:
            exit(PageStyle::Ambiguous);
    end;
    exit(PageStyle::Standard);
end;
```

Values: `Standard`, `Strong`, `Favorable` (green), `Unfavorable` (red), `Ambiguous` (yellow), `Attention` (orange), plus `StandardAccent`, `StrongAccent`, `AttentionAccent`, `Subordinate`.
