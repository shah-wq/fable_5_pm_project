import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  LEGACY_LOGIN_PATHS,
  LOGIN_DOORS,
  ROLE_HOME,
  ROUTE_ACCESS,
  accessForPath,
  doorForPath,
  doorForRole,
  isLoginPath,
  roleToLandingRoute,
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

test('the chat is staff and customer only — never a dealer, never a designer', () => {
  // Project chat §2: "dealers do not participate". The thread carries what the
  // customer says about price, financing and delays, and a dealer reading it is
  // the one leak this module cannot take back.
  for (const path of ['/messages', '/api/chat', '/api/chat/abc/read']) {
    const allowed = accessForPath(path);
    assert.ok(allowed, `${path} must have an access rule`);
    for (const role of ['dealer', 'designer', 'finance'] as UserRole[]) {
      assert.ok(!allowed.includes(role), `${role} must not reach ${path}`);
    }
  }
  // The inbox is a staff surface; the API is used by both sides of the thread.
  assert.ok(!accessForPath('/messages')!.includes('customer'));
  assert.ok(accessForPath('/api/chat')!.includes('customer'));
  assert.ok(accessForPath('/api/chat')!.includes('ops'));
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
  assert.equal(doorForPath('/portal/documents').path, '/login/homeowner');
  assert.equal(doorForPath('/dealers').path, '/login/dealer');
  assert.equal(doorForPath('/pipeline').path, '/login');
  assert.equal(doorForPath('/admin/finance').path, '/login');
});

test('the three doors hang off one entry point', () => {
  // §2/§9: /login stays canonical and stays the staff page, so existing links
  // and bookmarks keep working; the other two are siblings, so they read
  // correctly in an invitation email.
  assert.equal(LOGIN_DOORS.staff.path, '/login');
  assert.equal(LOGIN_DOORS.dealer.path, '/login/dealer');
  assert.equal(LOGIN_DOORS.customer.path, '/login/homeowner');
});

test('login pages and their subpages are recognized', () => {
  assert.ok(isLoginPath('/login'));
  assert.ok(isLoginPath('/login/reset'));
  assert.ok(isLoginPath('/login/dealer'));
  assert.ok(isLoginPath('/login/homeowner'));
  assert.ok(!isLoginPath('/dealers'));
  assert.ok(!isLoginPath('/loginish'));
});

test('the old door paths stay public, and each names its replacement', () => {
  // They are in sent invitation emails and browser histories. A sign-in link is
  // the one broken link a user cannot work around.
  for (const [legacy, target] of Object.entries(LEGACY_LOGIN_PATHS)) {
    assert.ok(isLoginPath(legacy), `${legacy} must not require a session`);
    assert.ok(
      Object.values(LOGIN_DOORS).some((d) => d.path === target),
      `${legacy} must redirect to a real door, got ${target}`
    );
  }
  assert.equal(LEGACY_LOGIN_PATHS['/portal/login'], '/login/homeowner');
  assert.equal(LEGACY_LOGIN_PATHS['/dealers/login'], '/login/dealer');
});

test('roleToLandingRoute is the one place a role becomes a destination', () => {
  for (const [role, home] of Object.entries(ROLE_HOME) as [UserRole, string][]) {
    assert.equal(roleToLandingRoute(role), home);
  }
  // A deep link someone was sent to a door from is honoured.
  assert.equal(roleToLandingRoute('ops', { next: '/projects/abc' }), '/projects/abc');
  // Changing a forced password comes before anything else, including that link.
  assert.equal(
    roleToLandingRoute('ops', { next: '/projects/abc', forcePasswordChange: true }),
    '/auth/change-password?forced=1'
  );
  // Open-redirect attempts fall back to the role's own home.
  assert.equal(roleToLandingRoute('customer', { next: 'https://evil.example' }), '/portal');
  assert.equal(roleToLandingRoute('customer', { next: '//evil.example' }), '/portal');
  // And a ?next= pointing back at a sign-in page would bounce for ever.
  assert.equal(roleToLandingRoute('dealer', { next: '/login/dealer' }), '/dealers');
  assert.equal(roleToLandingRoute('admin', { next: '/' }), '/pipeline');
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
