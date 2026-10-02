# Shared cultivation clock records

2026-10-02 internal integration stage; no v10 runtime admission is enabled.

The original v9 cultivation clock algorithms are unchanged. Its three public
entry signatures and error behavior remain fixed. Structural record leaves now
read the shared World base, cultivation, clock, legacy identities and care records,
so a future v10 lifecycle root can call the same bounded checks without relabeling
a World or deleting unrelated ownership evidence.

The separate v10 wrapper is a record check, never a version, lifecycle, migration
or save-capacity certificate. Its owning root must authenticate those boundaries.

Root-only isolated regression: 3 files / 124 tests passed, including original
v9 clock and care cases plus exact shared-leaf results, old failure text and
getter rejection. No complete-game or v10 playable acceptance is claimed.
