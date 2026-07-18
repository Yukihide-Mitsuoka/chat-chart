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
  ];

  for (const name of legacyCopies) {
    await assert.rejects(stat(projectAdr(name)), { code: 'ENOENT' });
  }
});

test('project governance references use the foundation ADR namespace', async () => {
  const decisionLog = await readFile(`${repositoryRoot}/.ai/decision-log.md`, 'utf8');
  const architectureSkill = await readFile(
    `${repositoryRoot}/.skills/architecture.skill.md`,
    'utf8',
  );
  const projectAdr0005 = await readFile(
    projectAdr('0005-cache-and-authorization-architecture.md'),
    'utf8',
  );

  assert.doesNotMatch(decisionLog, /\.\.\/docs\/adr\/000[1-4]-/u);
  assert.match(architectureSkill, /docs\/foundation\/templates\/adr\.md/u);
  assert.doesNotMatch(projectAdr0005, /docs\/adr\/0000-template\.md/u);
});
