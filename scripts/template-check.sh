#!/usr/bin/env bash
# Template self-check ("make doctor"): fast, dependency-free validation that the
# foundation's own metadata invariants hold. Automates what a manual/agent audit would
# otherwise catch. Exits non-zero on any violation. Add checks here as invariants grow.
#
# Currently verifies:
#   1. Every .ai/*.md and .skills/*.skill.md begins with a valid YAML frontmatter block
#      (`---` ... `---`) — the metadata the routing/authority system depends on.
#   2. No file carries the "collapsed frontmatter" signature a non-frontmatter-aware
#      formatter produces (guards against the LOG-0007 regression recurring).
#   3. GitHub governance inheritance rejects invalid or weakening policy.
#   4. Child repositories with a manifest satisfy the local inheritance and legacy
#      Template Sync protection contract.
#   5. Foundation-owned project-documentation guides do not occupy project-owned paths.

set -u
cd "$(dirname "$0")/.." || exit 9

errors=0
err() { echo "  DOCTOR: $1"; errors=$((errors + 1)); }

# 1. Frontmatter present and closed in rule/skill files.
while IFS= read -r f; do
  first="$(head -n 1 "$f")"
  if [ "$first" != "---" ]; then
    err "$f: missing opening YAML frontmatter (first line is not '---')"
    continue
  fi
  # A closing --- must exist on lines 2..30.
  if ! tail -n +2 "$f" | head -n 30 | grep -qx -- '---'; then
    err "$f: opening '---' has no closing '---' in the first 30 lines"
  fi
done < <(find .ai .skills -type f -name '*.md' 2>/dev/null | sort)

# 2. Collapsed-frontmatter signature (what a frontmatter-unaware mdformat run produces:
#    the YAML keys mashed into a single heading like "## id: x title: y ...").
if grep -rlnE '^## (id|name): .+ (title|description): ' .ai .skills docs CLAUDE.md AGENTS.md 2>/dev/null; then
  err "^ file(s) above contain collapsed YAML frontmatter — run mdformat with mdformat-frontmatter (see LOG-0007)"
fi

# 3. Foundation-level governance policy contract tests (ADR-0003).
python3 -m unittest discover -s scripts/tests -p 'test_*.py' || err "GitHub governance policy tests failed"
python3 scripts/github_governance.py validate --root . >/dev/null || err "GitHub governance policy is invalid"

# 4. ADR-0007: validate the actual child contract, not only unit-test fixtures. The
# foundation root has no child manifest, so this remains a no-op there.
if [ -f ".github/inheritance/manifest.json" ]; then
  python3 scripts/template_inheritance.py validate --root . >/dev/null || \
    err "Template inheritance and legacy sync protection contract is invalid"
fi

# 5. ADR-0006 ownership boundary: reusable scaffolding belongs under docs/foundation/.
# Only the canonical foundation repository bans legacy project-path copies. Legacy
# direct Template Sync children do not necessarily carry an inheritance manifest, so
# manifest absence cannot identify the root. Children may validly create repository-owned
# files at these paths, including README files (DOC-010).
foundation_origin="$(git config --get remote.origin.url 2>/dev/null)"
case "$foundation_origin" in
  https://github.com/Yukihide-Mitsuoka/ai-dev-foundation | \
    https://github.com/Yukihide-Mitsuoka/ai-dev-foundation.git | \
    git@github.com:Yukihide-Mitsuoka/ai-dev-foundation.git | \
    ssh://git@github.com/Yukihide-Mitsuoka/ai-dev-foundation.git)
    is_foundation_root=true
    ;;
  *)
    is_foundation_root=false
    ;;
esac

if [ "$is_foundation_root" = true ]; then
  for path in \
    docs/README.md \
    docs/api/README.md \
    docs/architecture/README.md \
    docs/deployment/README.md \
    docs/domain/README.md \
    docs/operations/README.md \
    docs/runbook/README.md \
    docs/troubleshooting/README.md \
    docs/usage.md \
    docs/usage.ja.md \
    docs/ai-instruction-files.ja.md \
    docs/troubleshooting/github-governance.md \
    docs/troubleshooting/template-inheritance.md \
    docs/glossary.md \
    docs/roadmap.md; do
    if [ -e "$path" ]; then
      err "$path: foundation-owned guidance must live under docs/foundation/ (ADR-0006)"
    fi
  done
  if find docs/adr -type f -print -quit 2>/dev/null | grep -q .; then
    err "docs/adr/: ai-dev-foundation ADRs must live under docs/foundation/adr/ (ADR-0006)"
  fi
fi

for path in \
  docs/foundation/guides/README.md \
  docs/foundation/guides/api.md \
  docs/foundation/guides/architecture.md \
  docs/foundation/guides/deployment.md \
  docs/foundation/guides/domain.md \
  docs/foundation/guides/operations.md \
  docs/foundation/guides/project-documentation.md \
  docs/foundation/guides/runbook.md \
  docs/foundation/guides/troubleshooting.md \
  docs/foundation/guides/usage.md \
  docs/foundation/guides/usage.ja.md \
  docs/foundation/guides/ai-instruction-files.ja.md \
  docs/foundation/adr/README.md \
  docs/foundation/adr/0001-record-architecture-decisions.md \
  docs/foundation/adr/0002-ai-facing-docs-in-english.md \
  docs/foundation/adr/0003-reconcile-github-governance-from-inherited-policy.md \
  docs/foundation/adr/0004-harden-multi-level-template-inheritance.md \
  docs/foundation/adr/0005-separate-foundation-and-project-document-languages.md \
  docs/foundation/adr/0006-reserve-a-foundation-documentation-namespace.md \
  docs/foundation/adr/0007-constrain-transitional-template-sync.md \
  docs/foundation/troubleshooting/README.md \
  docs/foundation/troubleshooting/github-governance.md \
  docs/foundation/troubleshooting/template-inheritance.md \
  docs/foundation/glossary.md \
  docs/foundation/templates/adr.md \
  docs/foundation/templates/glossary.md \
  docs/foundation/templates/roadmap.md; do
  if [ ! -f "$path" ]; then
    err "$path: required foundation documentation guide is missing"
  fi
done

if [ "$errors" -eq 0 ]; then
  echo "doctor: OK — template invariants hold"
else
  echo "doctor: $errors problem(s) found"
fi
[ "$errors" -eq 0 ]
