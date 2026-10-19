import { test, expect, beforeAll, afterAll, describe } from 'bun:test';
import { route, loadCfg, type RouterCfg } from '../../engine/router/route.ts';
import { useRepoProject } from '../helpers.ts';

let restore: () => void;
let cfg: RouterCfg;
beforeAll(() => { restore = useRepoProject(); cfg = loadCfg(); });
afterAll(() => restore());

describe('route()', () => {
  test('classify task goes to e-classifier on the cheap tier', () => {
    const r = route('classify this ticket', {}, cfg);
    expect(r.rule).toBe('classify');
    expect(r.employee).toBe('e-classifier');
    expect(r.tier).toBe('cheap');
    expect(r.escalated).toBe(false);
  });

  test('UI wiring task matches the ui-api rule on e-coder', () => {
    const r = route('wire the save button to POST /orders', {}, cfg);
    expect(r.rule).toBe('ui-api');
    expect(r.employee).toBe('e-coder');
    expect(r.tier).toBe('mid');
    expect(r.skills).toContain('ui-api-call');
    expect(r.model).toBe('sonnet');
  });

  test('risk=high escalates one tier', () => {
    const r = route('wire the save button to POST /orders', { risk: 'high' }, cfg);
    expect(r.tier).toBe('deep');
    expect(r.escalated).toBe(true);
    expect(r.reasons.join(' ')).toContain('risk=high');
  });

  test('more than 8 files escalates one tier; exactly 8 does not', () => {
    expect(route('classify this', { files: 9 }, cfg).tier).toBe('mid');
    expect(route('classify this', { files: 8 }, cfg).tier).toBe('cheap');
  });

  test('failures escalate and cap at deep', () => {
    expect(route('classify this', { failures: 1 }, cfg).tier).toBe('mid');
    expect(route('classify this', { failures: 2 }, cfg).tier).toBe('deep');
    expect(route('classify this', { failures: 5 }, cfg).tier).toBe('deep');
  });

  test('no keyword hits falls back to the default rule', () => {
    const r = route('hello world', {}, cfg);
    expect(r.rule).toBe('default');
    expect(r.employee).toBe(cfg.routes.defaults.employee);
    expect(r.reasons[0]).toContain('no keyword hits');
  });

  test('unknown employee throws', () => {
    const bad: RouterCfg = { ...cfg, routes: { ...cfg.routes, defaults: { ...cfg.routes.defaults, employee: 'nobody' } } };
    expect(() => route('hello world', {}, bad)).toThrow(/unknown employee "nobody"/);
  });

  test('FLEET_PROVIDER selects the model map', () => {
    const prev = process.env.FLEET_PROVIDER;
    process.env.FLEET_PROVIDER = 'custom';
    try {
      expect(route('classify this', {}, cfg).model).toBe('inherit'); // custom has empty model ids
    } finally {
      if (prev === undefined) delete process.env.FLEET_PROVIDER; else process.env.FLEET_PROVIDER = prev;
    }
  });
});
