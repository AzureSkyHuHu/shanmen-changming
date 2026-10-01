# Static combat content validation

Run from the repository root:

```sh
node --experimental-strip-types tools/validate-content/index.ts
```

The CLI validates strict data shape, IDs, references, tree topology and reachability, operation capabilities, numeric bounds, lifecycle ownership and all combat locale keys/parameters. Exit status is nonzero for errors. Expected warnings currently report the 12/48 talent backlog and absence of execution/balance/asset certification.

`tests/content/combat-content.test.ts` contains intentionally broken fixtures and catalog/locale contract tests. The integration owner runs these through the normal Vitest/typecheck/build flow. Static tests do not certify any battle mechanic.

UI integration may merge `combatZhCN` / `combatEn` from their separate `combat.ts` locale files and `combatMessageSpecifications` from `src/content/definitions/messages.ts`. Definitions supply description parameter values; never copy tuning numbers into presentation code. Display `unbalanced-baseline` and non-verified availability honestly. Runtime content loading must use runtime validation with the actual executor's capability registry.
