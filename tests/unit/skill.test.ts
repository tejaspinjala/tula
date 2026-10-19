import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { splitSkill, render, cli, listSkills } from '../../engine/bin/skill.ts';
import { useRepoProject } from '../helpers.ts';

let restore: () => void;
beforeAll(() => { restore = useRepoProject(); });
afterAll(() => restore());

const SAMPLE = `---
name: demo
description: A demo skill.
---
# demo
Core text here.

## First
Line one of first.
more

## Second
Only line.
`;

describe('splitSkill', () => {
  test('parses frontmatter, core and sections', () => {
    const s = splitSkill(SAMPLE);
    expect(s.data.name).toBe('demo');
    expect(s.core).toBe('Core text here.');
    expect(s.sections.map((x) => x.title)).toEqual(['First', 'Second']);
    expect(s.sections[0]?.body).toBe('Line one of first.\nmore');
  });
});

describe('render', () => {
  test('default form has core and section index', () => {
    const out = render('handoff');
    expect(out).toContain('Sections (load with --section');
    expect(out).toContain('- Format:');
    expect(out).toContain('Write brain/runs/');
  });

  test('section form returns only that section (prefix, case-insensitive)', () => {
    const out = render('handoff', { section: 'format' });
    expect(out.startsWith('## Format\n')).toBe(true);
    expect(out).not.toContain('Sections (load with');
  });

  test('--index prints the index only, no core text', () => {
    const out = render('handoff', { index: true });
    expect(out.startsWith('Sections (load with --section "<name>"):')).toBe(true);
    expect(out).toContain('- Format:');
    expect(out).not.toContain('Write brain/runs/');
  });

  test('unknown skill throws', () => {
    expect(() => render('nope-nope')).toThrow(/unknown skill "nope-nope"/);
  });

  test('unknown section throws and lists sections', () => {
    expect(() => render('handoff', { section: 'zzz' })).toThrow(/no section "zzz" in handoff\. Sections: .*Format/);
  });
});

describe('cli', () => {
  test('--index flag', () => {
    const out = cli(['handoff', '--index']);
    expect(out).toContain('- Format:');
    expect(out).not.toContain('Write brain/runs/');
  });
  test('--section flag', () => {
    expect(cli(['handoff', '--section', 'Format'])).toStartWith('## Format');
  });
  test('--list and no args list every skill', () => {
    const listed = cli(['--list']);
    expect(listed).toBe(cli([]));
    expect(listed.split('\n').length).toBe(listSkills().length);
    expect(listed).toContain('handoff: ');
  });
});
