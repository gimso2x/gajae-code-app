import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import { markDesktopShell } from './externalLink';
import {
  getBrowserNotificationsEnabled,
  getNotificationPermission,
  requestNotificationPermission,
  setBrowserNotificationsEnabled,
  showBrowserNotification,
} from './browserNotification';

type MockNotificationInstance = {
  title: string;
  options?: NotificationOptions;
  onclick: (() => void) | null;
  close: () => void;
  closed: boolean;
};

let originalNotification: typeof Notification | undefined;
let originalVisibilityState: DocumentVisibilityState;
let originalHasFocus: () => boolean;
let originalIsSecureContext: boolean;
let instances: MockNotificationInstance[] = [];
let mockPermission: NotificationPermission = 'default';

class MockNotification {
  static get permission(): NotificationPermission {
    return mockPermission;
  }

  static async requestPermission(): Promise<NotificationPermission> {
    return mockPermission;
  }

  title: string;
  options?: NotificationOptions;
  onclick: (() => void) | null = null;
  closed = false;

  constructor(title: string, options?: NotificationOptions) {
    this.title = title;
    this.options = options;
    instances.push(this);
  }

  close(): void {
    this.closed = true;
  }
}

beforeEach(() => {
  originalNotification = (window as unknown as { Notification?: typeof Notification }).Notification;
  originalVisibilityState = document.visibilityState;
  originalHasFocus = document.hasFocus;
  originalIsSecureContext = window.isSecureContext;

  instances = [];
  mockPermission = 'default';
  localStorage.clear();
  markDesktopShell(false);

  (window as unknown as { Notification: unknown }).Notification = MockNotification;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true, writable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
  document.hasFocus = () => false;
});

afterEach(() => {
  if (originalNotification) {
    (window as unknown as { Notification: typeof Notification }).Notification = originalNotification;
  } else {
    delete (window as unknown as { Notification?: typeof Notification }).Notification;
  }
  Object.defineProperty(document, 'visibilityState', { value: originalVisibilityState, configurable: true, writable: true });
  document.hasFocus = originalHasFocus;
  Object.defineProperty(window, 'isSecureContext', { value: originalIsSecureContext, configurable: true, writable: true });
  localStorage.clear();
  markDesktopShell(false);
});

test('getNotificationPermission returns unsupported when Notification is not in window', () => {
  delete (window as unknown as { Notification?: typeof Notification }).Notification;
  assert.equal(getNotificationPermission(), 'unsupported');
});

test('getNotificationPermission returns unsupported when in desktop shell', () => {
  markDesktopShell(true);
  assert.equal(getNotificationPermission(), 'unsupported');
});

test('getNotificationPermission returns unsupported when insecure context', () => {
  Object.defineProperty(window, 'isSecureContext', { value: false, configurable: true, writable: true });
  assert.equal(getNotificationPermission(), 'unsupported');
});

test('getNotificationPermission returns mockPermission', () => {
  mockPermission = 'granted';
  assert.equal(getNotificationPermission(), 'granted');
  mockPermission = 'denied';
  assert.equal(getNotificationPermission(), 'denied');
});

test('requestNotificationPermission returns granted and does not re-request if already granted', async () => {
  mockPermission = 'granted';
  let requestCalled = false;
  MockNotification.requestPermission = async () => {
    requestCalled = true;
    return 'granted';
  };
  const result = await requestNotificationPermission();
  assert.equal(result, 'granted');
  assert.equal(requestCalled, false);
});

test('requestNotificationPermission calls Notification.requestPermission when default', async () => {
  mockPermission = 'default';
  let requestCalled = false;
  MockNotification.requestPermission = async () => {
    requestCalled = true;
    mockPermission = 'granted';
    return 'granted';
  };
  const result = await requestNotificationPermission();
  assert.equal(result, 'granted');
  assert.equal(requestCalled, true);
});

test('getBrowserNotificationsEnabled and setBrowserNotificationsEnabled persist to localStorage', () => {
  assert.equal(getBrowserNotificationsEnabled(), false);
  const success = setBrowserNotificationsEnabled(true);
  assert.equal(success, true);
  assert.equal(getBrowserNotificationsEnabled(), true);

  setBrowserNotificationsEnabled(false);
  assert.equal(getBrowserNotificationsEnabled(), false);
});

test('showBrowserNotification does not show when opt-in is false', () => {
  mockPermission = 'granted';
  setBrowserNotificationsEnabled(false);
  const notif = showBrowserNotification('Test', { body: 'Hello' });
  assert.equal(notif, null);
  assert.equal(instances.length, 0);
});

test('showBrowserNotification does not show when permission is not granted', () => {
  mockPermission = 'default';
  setBrowserNotificationsEnabled(true);
  const notif = showBrowserNotification('Test', { body: 'Hello' });
  assert.equal(notif, null);
  assert.equal(instances.length, 0);
});

test('showBrowserNotification suppresses when document is visible AND has focus', () => {
  mockPermission = 'granted';
  setBrowserNotificationsEnabled(true);

  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
  document.hasFocus = () => true;

  const notif = showBrowserNotification('Test', { body: 'Hello' });
  assert.equal(notif, null);
  assert.equal(instances.length, 0);
});

test('showBrowserNotification shows when document is visible but lacks focus', () => {
  mockPermission = 'granted';
  setBrowserNotificationsEnabled(true);

  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true, writable: true });
  document.hasFocus = () => false;

  const notif = showBrowserNotification('Test', { body: 'Hello' });
  assert.ok(notif);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].title, 'Test');
  assert.equal(instances[0].options?.body, 'Hello');
});

test('showBrowserNotification shows when document is hidden', () => {
  mockPermission = 'granted';
  setBrowserNotificationsEnabled(true);

  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true, writable: true });
  document.hasFocus = () => false;

  const notif = showBrowserNotification('Run Finished', { body: 'Task completed successfully' });
  assert.ok(notif);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].title, 'Run Finished');
});

test('showBrowserNotification onclick focuses window and closes notification', () => {
  mockPermission = 'granted';
  setBrowserNotificationsEnabled(true);

  let focusCalled = false;
  window.focus = () => {
    focusCalled = true;
  };

  const notif = showBrowserNotification('Test', { body: 'Hello' });
  assert.ok(notif);
  assert.ok(instances[0].onclick);

  instances[0].onclick();
  assert.equal(focusCalled, true);
  assert.equal(instances[0].closed, true);
});
