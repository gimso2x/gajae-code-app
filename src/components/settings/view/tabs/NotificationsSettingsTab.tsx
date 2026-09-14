import { useEffect, useState } from 'react';
import { Bell, BellOff, BellRing, Play, Volume2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '../../../../shared/view/ui';
import {
  getNotificationPermission,
  requestNotificationPermission,
  showBrowserNotification,
} from '../../../../utils/browserNotification';
import { playChatCompletionSound } from '../../../../utils/notificationSound';
import type { NotificationPreferencesState } from '../../types/types';

type NotificationsSettingsTabProps = {
  notificationPreferences: NotificationPreferencesState;
  onNotificationPreferencesChange: (value: NotificationPreferencesState) => void;
  isDesktop?: boolean;
  desktopNotifications?: { enabled: boolean; supported: boolean; connectedCount?: number; targetCount?: number; lastError?: string | null } | null;
  onEnableDesktopNotifications?: () => void;
  onDisableDesktopNotifications?: () => void;
  browserNotificationsEnabled?: boolean;
  onBrowserNotificationsEnabledChange?: (enabled: boolean) => void;
  browserNotificationError?: string | null;
};
type EventName = keyof NotificationPreferencesState['events'];

function EventCheckbox({ event, label, preferences, onChange }: {
  event: EventName;
  label: string;
  preferences: NotificationPreferencesState;
  onChange: (value: NotificationPreferencesState) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-foreground">
      <input
        type="checkbox"
        checked={preferences.events[event]}
        onChange={(input) => onChange({
          ...preferences,
          events: { ...preferences.events, [event]: input.target.checked },
        })}
        className="h-4 w-4"
      />
      {label}
    </label>
  );
}

export default function NotificationsSettingsTab(props: NotificationsSettingsTabProps) {
  const { t } = useTranslation('settings');
  const { notificationPreferences: preferences, onNotificationPreferencesChange: changePreferences } = props;
  const desktopEnabled = props.desktopNotifications?.enabled;
  const [browserPermission, setBrowserPermission] = useState(getNotificationPermission);
  const [isRequestingPermission, setIsRequestingPermission] = useState(false);

  useEffect(() => {
    const update = () => setBrowserPermission(getNotificationPermission());
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      window.removeEventListener('focus', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, []);

  const handleRequestBrowserPermission = async () => {
    setIsRequestingPermission(true);
    try {
      const result = await requestNotificationPermission();
      setBrowserPermission(result);
      if (result === 'granted') {
        props.onBrowserNotificationsEnabledChange?.(true);
      }
    } finally {
      setIsRequestingPermission(false);
    }
  };
  const toggleDesktop = () => {
    if (desktopEnabled) {
      props.onDisableDesktopNotifications?.();
    } else {
      props.onEnableDesktopNotifications?.();
    }
  };

  return (
    <div className="space-y-6 md:space-y-8">
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Bell className="h-5 w-5 text-primary" />
          <h3 className="text-lg font-medium text-foreground">{t('notifications.title')}</h3>
        </div>
        <p className="text-sm text-muted-foreground">{t('notifications.description')}</p>
      </div>

      {props.isDesktop ? (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <h4 className="font-medium text-foreground">
            {t('notifications.desktop.title', { defaultValue: 'Notify this desktop app' })}
          </h4>
          {props.desktopNotifications?.supported === false ? (
            <p className="text-sm text-muted-foreground">
              {t('notifications.desktop.unsupported', { defaultValue: 'Desktop notifications are not supported on this system.' })}
            </p>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={toggleDesktop}
                  className={desktopEnabled
                    ? 'inline-flex items-center gap-2 rounded-md bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive transition-colors hover:bg-destructive/20'
                    : 'inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90'}
                >
                  {desktopEnabled ? <BellOff className="h-4 w-4" /> : <BellRing className="h-4 w-4" />}
                  {desktopEnabled
                    ? t('notifications.desktop.disable', { defaultValue: 'Disable desktop notifications' })
                    : t('notifications.desktop.enable', { defaultValue: 'Enable desktop notifications' })}
                </button>
                {desktopEnabled && (
                  <span className="text-sm text-muted-foreground">
                    {t('notifications.desktop.enabled', { defaultValue: 'Desktop notifications are enabled' })}
                  </span>
                )}
              </div>
              {props.desktopNotifications?.lastError && (
                <p className="text-sm text-destructive">{props.desktopNotifications.lastError}</p>
              )}
            </div>
          )}
        </div>
      ) : null}

      {!props.isDesktop ? (
        <div className="space-y-4 rounded-lg border border-border bg-card p-4">
          <div className="space-y-1">
            <h4 className="font-medium text-foreground">
              {t('notifications.browser.title', { defaultValue: 'Browser & PWA notifications' })}
            </h4>
            <p className="text-sm text-muted-foreground">
              {t('notifications.browser.description', {
                defaultValue: 'Show Windows native toast notifications when a run completes or needs approval while the app is open.',
              })}
            </p>
          </div>

          {browserPermission === 'unsupported' ? (
            <p className="text-sm text-muted-foreground">
              {t('notifications.browser.unsupported', {
                defaultValue: 'Browser notifications are not supported on this browser or require a secure context (HTTPS or localhost).',
              })}
            </p>
          ) : browserPermission === 'denied' ? (
            <div className="space-y-2">
              <p className="text-sm text-destructive">
                {t('notifications.browser.denied', {
                  defaultValue: 'Notifications are blocked by your browser. To enable them, allow notifications in your browser or PWA site settings.',
                })}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('notifications.browser.windowsHint', {
                  defaultValue: 'Tip: Also ensure Windows Settings → System → Notifications allows notifications from your browser, and Focus assist is off.',
                })}
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <Bell className="h-4 w-4 text-primary" />
                    <span className="text-sm font-medium text-foreground">
                      {t('notifications.browser.statusTitle', { defaultValue: 'Desktop notifications' })}
                    </span>
                  </div>
                  {browserPermission === 'default' ? (
                    <p className="text-xs text-muted-foreground">
                      {t('notifications.browser.defaultHint', { defaultValue: 'Browser permission is required before notifications can be shown.' })}
                    </p>
                  ) : null}
                </div>

                {browserPermission === 'default' ? (
                  <Button
                    type="button"
                    size="sm"
                    disabled={isRequestingPermission}
                    onClick={handleRequestBrowserPermission}
                  >
                    <BellRing className="h-4 w-4" />
                    {t('notifications.browser.enable', { defaultValue: 'Enable notifications' })}
                  </Button>
                ) : (
                  <label className="flex shrink-0 items-center gap-2 text-sm text-foreground">
                    <input
                      type="checkbox"
                      checked={Boolean(props.browserNotificationsEnabled)}
                      onChange={(input) => props.onBrowserNotificationsEnabledChange?.(input.target.checked)}
                      className="h-4 w-4"
                    />
                    {t('notifications.browser.enabledToggle', { defaultValue: 'Enabled' })}
                  </label>
                )}
              </div>

              {browserPermission === 'granted' && props.browserNotificationsEnabled ? (
                <div className="flex items-center gap-2 pt-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      showBrowserNotification(
                        t('notifications.browser.testTitle', { defaultValue: 'Gajae Code' }),
                        {
                          body: t('notifications.browser.testBody', { defaultValue: 'This is a test notification from Gajae Code.' }),
                          force: true,
                        },
                      );
                    }}
                  >
                    <Play className="h-4 w-4" />
                    {t('notifications.browser.test', { defaultValue: 'Test notification' })}
                  </Button>
                  <span className="text-xs text-muted-foreground">
                    {t('notifications.browser.testHint', { defaultValue: 'Fires a test Windows toast notification immediately.' })}
                  </span>
                </div>
              ) : null}

              {props.browserNotificationError && (
                <p className="text-sm text-destructive">{props.browserNotificationError}</p>
              )}
            </div>
          )}
        </div>
      ) : null}

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Volume2 className="h-4 w-4 text-primary" />
              <h4 className="font-medium text-foreground">{t('notifications.sound.title', { defaultValue: 'Sound' })}</h4>
            </div>
            <p className="text-sm text-muted-foreground">
              {t('notifications.sound.description', { defaultValue: 'Play a short tone when a chat run finishes.' })}
            </p>
          </div>
          <label className="flex shrink-0 items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={preferences.channels.sound}
              onChange={(input) => changePreferences({
                ...preferences,
                channels: { ...preferences.channels, sound: input.target.checked },
              })}
              className="h-4 w-4"
            />
            {t('notifications.sound.enabled', { defaultValue: 'Enabled' })}
          </label>
        </div>
        <Button type="button" variant="outline" size="sm" onClick={() => { void playChatCompletionSound({ force: true }); }}>
          <Play className="h-4 w-4" />
          {t('notifications.sound.test', { defaultValue: 'Test sound' })}
        </Button>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-card p-4">
        <h4 className="font-medium text-foreground">{t('notifications.events.title')}</h4>
        <div className="space-y-3">
          <EventCheckbox event="actionRequired" label={t('notifications.events.actionRequired')} preferences={preferences} onChange={changePreferences} />
          <EventCheckbox event="stop" label={t('notifications.events.stop')} preferences={preferences} onChange={changePreferences} />
          <EventCheckbox event="error" label={t('notifications.events.error')} preferences={preferences} onChange={changePreferences} />
        </div>
      </div>
    </div>
  );
}
