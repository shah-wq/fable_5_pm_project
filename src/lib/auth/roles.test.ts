import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LOGIN_DOORS,
  ROLE_HOME,
  ROUTE_ACCESS,
  accessForPath,
  doorForPath,
  doorForRole,
  isLoginPath,
  sanitizeNextPath,
  type UserRole,
} from './roles.ts';

// Run: npm run test:unit -w apps/web

test('every role home is reachable by that role', () => {
  for (const [role, home] of Object.entries(ROLE_HOME) as [UserRole, string][]) {
    const allowed = accessForPath(home);
    assert.ok(allowed, `${home} must have an access rule`);
    assert.ok(allowed.includes(role), `${role} must be allowed on its own home ${home}`);
  }
});

test('longest prefix wins: finance carve-out inside /admin', () => {
  assert.deepEqual(accessForPath('/admin/finance'), ROUTE_ACCESS['/admin/finance']);
  assert.deepEqual(accessForPath('/admin/finance/invoices'), ROUTE_ACCESS['/admin/finance']);
  assert.deepEqual(accessForPath('/admin'), ROUTE_ACCESS['/admin']);
  assert.deepEqual(accessForPath('/admin/users'), ROUTE_ACCESS['/admin']);
  assert.ok(!accessForPath('/admin')!.includes('finance'));
  assert.ok(!accessForPath('/administrator'), 'prefix match must respect segment boundaries');
});

test('wrong-role combinations are denied everywhere it matters', () => {
  const cases: Array<[string, UserRole]> = [
    ['/admin', 'ops'],
    ['/admin', 'designer'],
    ['/admin', 'finance'],
    ['/pipeline', 'dealer'],
    ['/pipeline', 'customer'],
    ['/designer', 'ops'],
    ['/portal', 'admin'],
    ['/portal', 'dealer'],
    ['/dealers', 'customer'],
    ['/dealers', 'admin'],
    ['/api/invites', 'ops'],
  ];
  for (const [path, role] of cases) {
    assert.ok(!accessForPath(path)!.includes(role), `${role} must not access ${path}`);
  }
});

test('every role has exactly one door', () => {
  const seen = new Map<UserRole, string>();
  for (const door of Object.values(LOGIN_DOORS)) {
    for (const role of door.roles) {
      assert.ok(!seen.has(role), `${role} appears on two doors`);
      seen.set(role, door.path);
    }
  }
  for (const role of Object.keys(ROLE_HOME) as UserRole[]) {
    assert.ok(seen.has(role), `${role} has no door`);
    assert.equal(doorForRole(role).path, seen.get(role));
  }
});

test('unauthenticated visitors are sent to the door of their area', () => {
  assert.equal(doorForPath('/portal/documents').path, '/portal/login');
  assert.equal(doorForPath('/dealers').path, '/dealers/login');
  assert.equal(doorForPath('/pipeline').path, '/login');
  assert.equal(doorForPath('/admin/finance').path, '/login');
});

test('login pages and their subpages are recognized', () => {
  assert.ok(isLoginPath('/login'));
  assert.ok(isLoginPath('/login/reset'));
  assert.ok(isLoginPath('/dealers/login'));
  assert.ok(isLoginPath('/portal/login'));
  assert.ok(!isLoginPath('/dealers'));
  assert.ok(!isLoginPath('/loginish'));
});

test('sanitizeNextPath blocks open redirects', () => {
  assert.equal(sanitizeNextPath('/pipeline?tab=due'), '/pipeline?tab=due');
  assert.equal(sanitizeNextPath('https://evil.example'), null);
  assert.equal(sanitizeNextPath('//evil.example'), null);
  assert.equal(sanitizeNextPath('/\\evil.example'), null);
  assert.equal(sanitizeNextPath('/portal:8080'), null);
  assert.equal(sanitizeNextPath('portal'), null);
  assert.equal(sanitizeNextPath(''), null);
  assert.equal(sanitizeNextPath(null), null);
});
