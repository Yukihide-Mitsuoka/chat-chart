---
id: template-inheritance-troubleshooting
title: Template Inheritance Troubleshooting
updated: 2026-07-18
---

# Template Inheritance Troubleshooting

This guide diagnoses read-only inheritance validation and planning failures. It does not
authorize fetching, materialization, deletion, or a lock change.

## `parent origin does not match manifest.parent.repository`

**Affects:** `scripts/template_inheritance.py plan`

**Cause:** `--parent-root` points to a different GitHub repository than the manifest's
direct parent.

**Fix:** Select the declared parent's local checkout. If the manifest is wrong, change
it only through a reviewed child-repository PR.

**Refs:** #32, ADR-0004

## `locked commit is not on the remote branch first-parent history`

**Affects:** `scripts/template_inheritance.py plan`

**Cause:** The lock is not on the local `origin/<branch>` first-parent chain, or the
local parent checkout lacks the required history.

**Fix:** Confirm the parent and branch from the manifest, then explicitly refresh the
local parent checkout. Do not replace the lock merely to silence this error; investigate
whether upstream history changed or the wrong parent was selected.

**Refs:** #32, ADR-0004
