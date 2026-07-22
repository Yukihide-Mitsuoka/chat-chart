---
id: github-governance-troubleshooting
title: GitHub Governance Troubleshooting
updated: 2026-07-22
---

# GitHub Governance Troubleshooting

This guide resolves governance validation and read-only audit failures. It does not
authorize or perform GitHub setting changes.

## `audit` exits with status 1

**Affects:** `scripts/github_governance.py audit`

**Cause:** At least one control is `drift` or `unknown`. A required check name that is
not observed on the target branch head is also drift.

**Fix:**

1. Read the JSON `controls` entries whose `status` is not `compliant`.
2. For `drift`, review the desired policy and current GitHub state. Use the documented
   exact-confirmation `apply` flow only after the change is approved.
3. For `unknown`, rerun locally with `gh` authentication that can read repository
   administration settings.
4. For `branch.required_status_checks_observed`, verify the named workflow runs on the
   target branch and rerun the audit after it completes.

**Prevention:** Run `plan` after changing policy or required workflow names.

**Refs:** #18, ADR-0003

## `apply` verifies a Ruleset action but fails during replanning

**Affects:** `scripts/github_governance.py apply`

**Cause:** GitHub reports a branch protected by a Ruleset as `protected=true`, while the
legacy branch-protection endpoint returns HTTP 404 because no classic protection exists.
Older reconciler versions treated this combination as an unreadable legacy policy and
made the otherwise compliant report `unknown`.

**Fix:** Update to a reconciler containing issue #56. Rerun `plan`; a repository-admin
read that confirms HTTP 404 is recorded as absent legacy protection. Do not repeat
`apply` while the report is `unknown`; first verify that every attempted action reached
`compliant` in the redacted failure evidence.

**Prevention:** Keep the discovery regression for a Ruleset-only branch. Permission or
transport failures must remain `unknown`; only a confirmed 404 with repository-admin
access proves absence.

**Refs:** #56, ADR-0003

## `governance policy error: profiles must form one parent chain rooted at ai-dev-foundation`

**Affects:** all `scripts/github_governance.py` commands

**Cause:** Profiles are branched, cyclic, orphaned, or do not connect to the foundation
root through their explicit `parent` fields. Duplicate IDs produce their own explicit
error before chain validation.

**Fix:** Keep only the profiles for this repository's direct-parent lineage. Set the
first profile parent to `ai-dev-foundation` and each later parent to the preceding
profile ID; file names do not set the order.

**Prevention:** Run offline `validate` in the profile-owning template before inheritance.

**Refs:** #32, ADR-0004

## `governance policy error: profile directory must not use symlinks`

**Affects:** all `scripts/github_governance.py` commands

**Cause:** The profile directory or one of its parent components inside the repository
is a symlink.

**Fix:** Replace linked path components with reviewed regular directories inside the
repository.

**Prevention:** Keep the governance directory entirely repository-owned.

**Refs:** #32, ADR-0004, SEC-010

## `governance policy error: profile must be a regular file without symlinks`

**Affects:** all `scripts/github_governance.py` commands

**Cause:** A discovered `.github/governance/profiles/*.json` entry is a symlink or is not
a regular file.

**Fix:** Replace it with a reviewed regular JSON file inside the profile directory.

**Prevention:** Inherit committed profile files; do not link policy from outside the
repository.

**Refs:** #32, ADR-0004, SEC-010
