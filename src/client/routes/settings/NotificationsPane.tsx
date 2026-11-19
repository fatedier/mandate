import { useState } from "react";
import { MoreHorizontal, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { reportPresenceNow } from "@/lib/in-app-notifications";
import { pageNotifySupport, type PageNotifySupport } from "@/lib/notification-support";
import { isTauriRuntime } from "@/lib/runtime";
import { cn } from "@/lib/utils";
import { testNotificationChannel } from "./settings-api";
import { useSaveUnit, useSettingsConfig } from "./settings-config";
import { TextField } from "./settings-fields";
import { SettingRow } from "./SettingRow";
import { SettingsSection } from "./SettingsSection";
import { StatusChip } from "./SettingsStatus";
import { TelegramChannelDialog } from "./TelegramChannelDialog";
import { channelDescription, channelPatch, failedText, isKnownKind, sentText } from "./notifications-form";
import type { NotificationChannelSettings, SettingsConfigResponse } from "@shared/settings";

const DEVICE_DESCRIPTION = "System notifications when this window isn't in use";

type ChannelsForm = { desktopApp: boolean; enabled: Record<string, boolean> };

function channelsForm(config: SettingsConfigResponse): ChannelsForm {
  return {
    desktopApp: config.notifications.desktopApp,
    enabled: Object.fromEntries(config.notifications.channels.map((channel) => [channel.id, channel.enabled]))
  };
}

/** Every switch as the user left it, not what differs from the config: a
 *  save queued behind another may be built against the config before it
 *  (switched off and on again, the second must still say on). */
function channelsPatch(form: ChannelsForm, config: SettingsConfigResponse) {
  const upsert = config.notifications.channels
    .filter((channel) => isKnownKind(channel.kind))
    .map((channel) => channelPatch(channel, { enabled: form.enabled[channel.id] ?? channel.enabled }));
  return { notifications: { desktopApp: form.desktopApp, ...(upsert.length > 0 ? { upsert } : {}) } };
}

/**
 * Settings › Notifications: where the personal agent's notices reach the user. This
 * device's own notifications first, then the channels (each with its test),
 * then the address links open at. Configuration only: a test's result shows
 * on its row until the page is left; nothing of past sends.
 */
export function NotificationsPane() {
  // While a save is on its way the switches and menus wait for it: a second
  // change built against the config before it would undo the first.
  const { config, savePatch, saving } = useSettingsConfig();
  const channels = useSaveUnit({ derive: channelsForm, buildPatch: channelsPatch });
  const links = useSaveUnit({
    derive: (c: SettingsConfigResponse) => ({ linkBase: c.notifications.linkBase }),
    buildPatch: (form: { linkBase: string }) => ({ notifications: { linkBase: form.linkBase.trim() || null } })
  });
  const [editing, setEditing] = useState<{ channel: NotificationChannelSettings | null } | null>(null);
  const [notes, setNotes] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [testing, setTesting] = useState<string | null>(null);
  if (!config || !channels.form || !links.form) return null;
  const form = channels.form;

  const test = async (channel: NotificationChannelSettings) => {
    setTesting(channel.id);
    try {
      const sent = await testNotificationChannel({ channelId: channel.id });
      setNotes((prev) => ({ ...prev, [channel.id]: { ok: true, text: sentText(sent.sentAt) } }));
    } catch (error) {
      setNotes((prev) => ({ ...prev, [channel.id]: { ok: false, text: failedText(error) } }));
    } finally {
      setTesting(null);
    }
  };
  const remove = (channel: NotificationChannelSettings) => {
    savePatch({ notifications: { remove: [channel.id] } }).catch((error: unknown) => {
      setNotes((prev) => ({ ...prev, [channel.id]: { ok: false, text: failedText(error) } }));
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        title="Channels"
        anchor="notifications-channels"
        headerSlot={<Button variant="outline" size="xs" onClick={() => setEditing({ channel: null })}>Add channel</Button>}
        rows
        footer={channels.footer}
      >
        {isTauriRuntime() ? (
          <SettingRow label="Desktop app" description={DEVICE_DESCRIPTION} fit="auto">
            <Switch
              aria-label="Desktop app notifications"
              disabled={saving}
              checked={form.desktopApp}
              onCheckedChange={(desktopApp) => channels.saveNow((prev) => ({ ...prev, desktopApp }))}
            />
          </SettingRow>
        ) : (
          <BrowserRow />
        )}
        {config.notifications.channels.map((channel) => {
          const note = notes[channel.id];
          const known = isKnownKind(channel.kind);
          return (
            <SettingRow
              key={channel.id}
              label={channel.name}
              description={channelDescription(channel)}
              fit="auto"
              hint={note ? <span className={note.ok ? "text-live" : "text-destructive"}>{note.text}</span> : undefined}
            >
              <div className="flex items-center gap-2">
                {known ? (
                  <>
                    <Button variant="outline" size="xs" disabled={testing !== null} onClick={() => void test(channel)}>Send test</Button>
                    <Switch
                      aria-label={`${channel.name} on`}
                      disabled={saving}
                      checked={form.enabled[channel.id] ?? channel.enabled}
                      onCheckedChange={(on) => channels.saveNow((prev) => ({ ...prev, enabled: { ...prev.enabled, [channel.id]: on } }))}
                    />
                  </>
                ) : null}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild disabled={saving}>
                    <Button variant="ghost" size="icon-xs" className="text-chrome hover:text-foreground" aria-label={`Actions for ${channel.name}`}>
                      <MoreHorizontal className="size-3.5" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {known ? (
                      <DropdownMenuItem onSelect={() => setEditing({ channel })}>
                        <Pencil className="h-4 w-4" />
                        Edit…
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem variant="destructive" onSelect={() => remove(channel)}>
                      <Trash2 className="h-4 w-4" />
                      Remove
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </SettingRow>
          );
        })}
      </SettingsSection>
      <SettingsSection title="Links" rows footer={links.footer}>
        <SettingRow
          anchor="notifications-link-base"
          label="Open links at"
          description="The address your other devices open Mandate at"
          hint="Unset, phone notifications carry no link."
        >
          <TextField
            ariaLabel="Open links at"
            value={links.form.linkBase}
            placeholder="http://"
            onChange={(linkBase) => links.setForm(() => ({ linkBase }))}
          />
        </SettingRow>
      </SettingsSection>
      {editing ? <TelegramChannelDialog channel={editing.channel} onClose={() => setEditing(null)} /> : null}
    </div>
  );
}

/** This browser's own notifications: allowed, the button that asks, or why not. */
function BrowserRow() {
  const [support, setSupport] = useState<PageNotifySupport>(() => pageNotifySupport());
  const allow = async () => {
    await window.Notification.requestPermission().catch(() => "default");
    setSupport(pageNotifySupport());
    reportPresenceNow();
  };
  const description = support === "unsupported"
    ? "Not available in this browser. Use a phone channel below."
    : support === "insecure"
      ? "Not available: this address isn't secure (https or localhost)."
      : DEVICE_DESCRIPTION;
  return (
    <SettingRow label="This browser" description={description} fit="auto">
      {support === "ok" ? <StatusChip tone="ready" label="Allowed" /> : null}
      {support === "default" ? <Button variant="outline" size="xs" onClick={() => void allow()}>Allow notifications</Button> : null}
      {support === "denied" ? <span className={cn("text-xs text-chrome")}>Blocked in this browser's settings</span> : null}
    </SettingRow>
  );
}
