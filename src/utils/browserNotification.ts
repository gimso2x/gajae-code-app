import { isDesktopShell } from './externalLink';

const BROWSER_NOTIFICATION_PREFERENCE = 'browserNotificationEnabled';

function isNotificationSupported(): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  if (isDesktopShell()) return false;
  if (!window.isSecureContext) return false;
  return 'Notification' in window && typeof window.Notification === 'function';
}

function isForeground(): boolean {
  if (typeof document === 'undefined') return true;
  return document.visibilityState === 'visible' && document.hasFocus();
}

export function getNotificationPermission(): NotificationPermission | 'unsupported' {
  if (!isNotificationSupported()) return 'unsupported';
  try {
    return window.Notification.permission;
  } catch {
    return 'unsupported';
  }
}

export async function requestNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (!isNotificationSupported()) return 'unsupported';
  const current = getNotificationPermission();
  if (current !== 'default') return current;

  try {
    return await window.Notification.requestPermission();
  } catch {
    return getNotificationPermission();
  }
}

export function getBrowserNotificationsEnabled(): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    return localStorage.getItem(BROWSER_NOTIFICATION_PREFERENCE) === 'true';
  } catch {
    return false;
  }
}

export function setBrowserNotificationsEnabled(enabled: boolean): boolean {
  if (typeof localStorage === 'undefined') return false;
  try {
    localStorage.setItem(BROWSER_NOTIFICATION_PREFERENCE, `${enabled}`);
    return true;
  } catch {
    return false;
  }
}

export function showBrowserNotification(
  title: string,
  options?: NotificationOptions & { force?: boolean },
): Notification | null {
  if (!isNotificationSupported()) return null;
  if (!getBrowserNotificationsEnabled()) return null;
  if (getNotificationPermission() !== 'granted') return null;
  if (!options?.force && isForeground()) return null;

  try {
    const { force: _force, ...domOptions } = options ?? {};
    const notification = new window.Notification(title, domOptions);
    notification.onclick = () => {
      try {
        window.focus();
      } catch {
        /* best-effort window focus */
      }
      try {
        notification.close();
      } catch {
        /* best-effort notification close */
      }
    };
    return notification;
  } catch (error) {
    console.warn('Unable to show browser notification:', error);
    return null;
  }
}
