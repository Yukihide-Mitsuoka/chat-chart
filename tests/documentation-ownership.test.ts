import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const projectAdr = (name: string): string => `${repositoryRoot}/docs/adr/${name}`;

test('foundation docs are not duplicated in the project namespace', async () => {
  const legacyCopies = [
    '0000-template.md',
    '0001-record-architecture-decisions.md',
    '0002-ai-facing-docs-in-english.md',
    '0003-reconcile-github-governance-from-inherited-policy.md',
    '0004-harden-multi-level-template-inheritance.md',
    '../README.md',
    '../usage.md',
    '../usage.ja.md',
    '../ai-instruction-files.ja.md',
    '../api/README.md',
    '../architecture/README.md',
    '../deployment/README.md',
    '../domain/README.md',
    '../operations/README.md',
    '../runbook/README.md',
    '../troubleshooting/README.md',
    '../troubleshooting/github-governance.md',
    '../troubleshooting/template-inheritance.md',
    '../templates/README.md',
    '../templates/requirements.md',
  ];

  for (const name of legacyCopies) {
    await assert.rejects(stat(projectAdr(name)), { code: 'ENOENT' });
  }
});

test('project governance references use the foundation ADR namespace', async () => {
  const decisionLog = await readFile(`${repositoryRoot}/.ai/decision-log.md`, 'utf8');
  const codeowners = await readFile(`${repositoryRoot}/.github/CODEOWNERS`, 'utf8');
  const architectureSkill = await readFile(
    `${repositoryRoot}/.skills/architecture.skill.md`,
    'utf8',
  );
  const projectAdr0005 = await readFile(
    projectAdr('0005-cache-and-authorization-architecture.md'),
    'utf8',
  );

  assert.doesNotMatch(decisionLog, /\.\.\/docs\/adr\/000[1-4]-/u);
  assert.match(codeowners, /docs\/foundation\/guides\/usage\.md/u);
  assert.doesNotMatch(codeowners, /docs\/usage\.md/u);
  assert.match(architectureSkill, /docs\/foundation\/templates\/adr\.md/u);
  assert.doesNotMatch(projectAdr0005, /docs\/adr\/0000-template\.md/u);
});

test('project glossary is Japanese and delegates foundation terms', async () => {
  const glossary = await readFile(`${repositoryRoot}/docs/glossary.md`, 'utf8');

  assert.match(glossary, /^# プロジェクト用語集$/mu);
  assert.match(glossary, /\]\(foundation\/glossary\.md\)/u);
  assert.doesNotMatch(glossary, /^\| ADR \|/mu);
});

test('project roadmap and requirements use the project documentation convention', async () => {
  const roadmap = await readFile(`${repositoryRoot}/docs/roadmap.md`, 'utf8');
  const requirements = await readFile(`${repositoryRoot}/docs/requirements.md`, 'utf8');

  assert.match(roadmap, /^# プロジェクトロードマップ$/mu);
  assert.doesNotMatch(roadmap, /<!-- TEMPLATE:/u);
  assert.match(requirements, /docs\/foundation\/templates\/requirements\.md/u);
  assert.doesNotMatch(requirements, /docs\/templates\/requirements\.md/u);
});
