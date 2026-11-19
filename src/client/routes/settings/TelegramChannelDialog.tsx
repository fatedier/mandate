import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { connectTelegramBot, testNotificationChannel } from "./settings-api";
import { useSettingsConfig } from "./settings-config";
import { TextField } from "./settings-fields";
import { failedText, sentText } from "./notifications-form";
import type { NotificationChannelPatch, NotificationChannelSettings } from "@shared/settings";

type Note = { ok: boolean; text: string } | null;

/**
 * Adds a Telegram channel, or changes one: its name, the bot's token, the
 * chat found with Connect (a bot cannot write first: the user writes to it,
 * then Connect reads who did), and whether the message text goes. A blank
 * token keeps the saved one. Save waits for a chat.
 */
export function TelegramChannelDialog({ channel, onClose }: { channel: NotificationChannelSettings | null; onClose: () => void }) {
  const { savePatch } = useSettingsConfig();
  const [name, setName] = useState(channel?.name ?? "Phone");
  const [token, setToken] = useState("");
  const [chatId, setChatId] = useState(channel?.values.chatId ?? "");
  const [botName, setBotName] = useState(channel?.values.botName ?? "");
  const [includeText, setIncludeText] = useState(channel?.includeText ?? true);
  const [busy, setBusy] = useState<"connect" | "test" | "save" | null>(null);
  const [connectNote, setConnectNote] = useState<Note>(chatId && botName ? { ok: true, text: `Connected to ${botName}.` } : null);
  const [testNote, setTestNote] = useState<Note>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const tokenSaved = channel?.secretsSaved.includes("botToken") ?? false;

  const patch = (): NotificationChannelPatch => ({
    ...(channel ? { id: channel.id } : {}),
    kind: "telegram",
    name: name.trim(),
    enabled: channel?.enabled ?? true,
    includeText,
    values: { botToken: token.trim(), chatId, botName }
  });

  // Another bot's token: the chat found for the old one is not its chat.
  const typeToken = (value: string) => {
    setToken(value);
    if (value.trim() && (chatId || botName)) {
      setChatId("");
      setBotName("");
      setConnectNote(null);
    }
  };

  const connect = async () => {
    setBusy("connect");
    try {
      const found = await connectTelegramBot({ ...(channel ? { channelId: channel.id } : {}), botToken: token.trim() });
      setChatId(found.chatId);
      setBotName(found.botName);
      setConnectNote({ ok: true, text: `Connected to ${found.botName}.` });
    } catch (error) {
      setConnectNote({ ok: false, text: failedText(error) });
    } finally {
      setBusy(null);
    }
  };
  const test = async () => {
    setBusy("test");
    try {
      const sent = await testNotificationChannel({ channel: patch() });
      setTestNote({ ok: true, text: sentText(sent.sentAt) });
    } catch (error) {
      setTestNote({ ok: false, text: failedText(error) });
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy("save");
    setSaveError(null);
    try {
      await savePatch({ notifications: { upsert: [patch()] } });
      onClose();
    } catch (error) {
      setSaveError(failedText(error));
      setBusy(null);
    }
  };

  const connected = Boolean(chatId);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && busy !== "save") onClose(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Telegram</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <TextField label="Name" ariaLabel="Name" value={name} onChange={setName} />
          <TextField label="Bot token" ariaLabel="Bot token" type="password" mono value={token} onChange={typeToken} />
          <div className="flex items-center gap-3 text-sm">
            <span className="min-w-0 flex-1 text-muted-foreground">Send any message to your bot, then press Connect.</span>
            <Button variant="outline" size="sm" disabled={busy !== null || (!token.trim() && !tokenSaved)} onClick={() => void connect()}>Connect</Button>
          </div>
          {connectNote ? <NoteLine note={connectNote} /> : null}
          <div className="flex items-center gap-3 text-sm">
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span>Include message text</span>
              <span className="text-xs text-chrome">Off: only the title leaves this computer.</span>
            </span>
            <Switch aria-label="Include message text" checked={includeText} onCheckedChange={setIncludeText} />
          </div>
          {testNote ? <NoteLine note={testNote} /> : null}
          {saveError ? <NoteLine note={{ ok: false, text: saveError }} /> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" disabled={busy !== null || !connected} onClick={() => void test()}>Send test</Button>
          <Button disabled={busy !== null || !connected || !name.trim()} onClick={() => void save()}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NoteLine({ note }: { note: { ok: boolean; text: string } }) {
  return <p className={cn("text-xs", note.ok ? "text-live" : "text-destructive")}>{note.text}</p>;
}
