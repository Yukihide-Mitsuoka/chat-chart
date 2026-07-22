---
id: template-inheritance-contract
title: Template Inheritance Contract
---

# Template Inheritance Contract

This directory defines the child-owned, direct-parent contract from
[ADR-0004](../../docs/foundation/adr/0004-harden-multi-level-template-inheritance.md)
and the bounded legacy transport from
[ADR-0007](../../docs/foundation/adr/0007-constrain-transitional-template-sync.md).
Validation and local history planning are read-only; materialization remains a follow-up.

## Schema version 1

`.github/inheritance/manifest.json` declares intent:

```json
{
  "schema_version": 1,
  "parent": {"repository": "acme/parent-template", "branch": "main"},
  "lock_file": ".github/inheritance/lock.json",
  "inherited_paths": [".ai/", "scripts/template_inheritance.py"],
  "protected_paths": [".gitignore", ".github/governance/repository.json", ".github/inheritance/lock.json", ".github/inheritance/manifest.json", ".github/workflows/template-sync.yml", ".templatesyncignore"]
}
```

The lock records the exact accepted parent commit:

```json
{"schema_version": 1, "parent": {"repository": "acme/parent-template", "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
```

An ownership root is either a literal file or a directory prefix ending in `/`. Globs,
absolute paths, traversal, `.git`, duplicates, and overlap within or across ownership
classes are invalid. Protected roots must cover the manifest, selected lock file,
`.gitignore`, `.templatesyncignore`, local governance policy, and sync workflow.

During the transitional Template Sync period, `.templatesyncignore` must also:

- cover every manifest `protected_paths` root;
- contain `.github/workflows/**`; and
- contain no `:!` exception that re-includes a protected root or workflow.

Entries ending in `/**` are treated as directory roots. The `:!` prefix is a Git
pathspec exclusion used by `actions-template-sync`, not `.gitignore` negation. The
intentional `:!docs/foundation/**` exception permits only the inherited foundation
documentation namespace.

`actions-template-sync@v2` exposes an abbreviated source hash even though its action
metadata calls the value a Git hash. The workflow must expand that exact abbreviation
through the GitHub commits API and validate the resulting 40-character commit before
writing PR provenance. Resolving only the current parent branch head is insufficient
because the parent can move while synchronization runs.

## Validate

```bash
python3 scripts/template_inheritance.py validate --root .
```

Exit `0` prints deterministic JSON; exit `2` reports invalid input on stderr. The command
performs no network request, file write, deletion, Git operation, or GitHub API call.
`make doctor` runs this validation automatically when the repository contains a child
manifest; the foundation root has no manifest and skips only this child-specific check.

## Propagate a parent change

Apply each row in order. Do not prepare a grandchild from an unmerged intermediate
template.

| Step | Required evidence |
|------|-------------------|
| 1. Update a direct child | Template Sync PR names the direct parent and the exact 40-character source commit |
| 2. Review inherited files | Accepted lock-to-source range reviewed; no protected path changed by transport |
| 3. Port workflows | Separate maintainer-authenticated PR verified against the same direct-parent source commit |
| 4. Advance the lock | Lock changes only in a reviewed PR after the complete parent delta is accepted |
| 5. Merge and continue | Only the merged child commit becomes the source for its direct children |

Template Sync must never auto-merge or apply repository governance. If validation fails,
disable `TEMPLATE_SYNC_ENABLED` until the manifest and local ignore contract agree.

## Plan the next parent commit

```bash
python3 scripts/template_inheritance.py plan --root . --parent-root ../parent-template
```

`--parent-root` must be the top level of a local Git worktree whose credential-free
GitHub `origin` matches the manifest. The local `origin/<branch>` ref must already be
available. Plan never fetches, checks out, writes, deletes, or calls GitHub.

Plan verifies that the lock is on that ref's first-parent history and selects only the
commit immediately after it. The report classifies that commit's paths:

| Field | Meaning |
|-------|---------|
| `add` | Inherited parent file is absent in the child |
| `modify` | Inherited content or executable mode differs |
| `candidate_delete` | Parent removed an inherited file; no deletion is performed |
| `already_current` | Child already matches the candidate state |
| `protected` | Child-owned path is reported and skipped |
| `unowned` | Path is outside both ownership lists and is skipped |

Exit `0` prints the deterministic plan, including candidate and branch-head commits.
Exit `2` reports invalid metadata, parent identity/history, Git state, or child path.
See [template inheritance troubleshooting](../../docs/foundation/troubleshooting/template-inheritance.md).
