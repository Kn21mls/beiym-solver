import browser from 'webextension-polyfill';
import type { CaptureRequest, CaptureResponse } from '../shared/messages';

let panelId: number | null = null;

async function capture(tab: browser.Tabs.Tab | undefined): Promise<CaptureResponse> {
  if (!tab || tab.id === undefined || tab.windowId === undefined) {
    return { ok: false, error: 'Не удалось определить вкладку Beyim.' };
  }
  try {
    await browser.tabs.update(tab.id, { active: true });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    return { ok: true, dataUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/activeTab|all_urls|permission/i.test(message)) {
      return { ok: false, error: 'Откройте панель с активной вкладки Beyim и повторите.' };
    }
    return { ok: false, error: message };
  }
}

async function openPanel(): Promise<void> {
  if (panelId !== null) {
    try {
      await browser.windows.update(panelId, { focused: true });
      return;
    } catch {
      panelId = null;
    }
  }
  const url = browser.runtime.getURL('panel.html');
  try {
    const created = await browser.windows.create({ url, type: 'popup', width: 480, height: 820 });
    panelId = created.id ?? null;
  } catch {
    await browser.tabs.create({ url });
  }
}

browser.action.onClicked.addListener(() => {
  void openPanel();
});

browser.runtime.onMessage.addListener((message: unknown, sender: browser.Runtime.MessageSender) => {
  const incoming = message as Partial<CaptureRequest>;
  if (!incoming || incoming.type !== 'capture') return undefined;
  return capture(sender.tab);
});

browser.windows.onRemoved.addListener((id) => {
  if (id === panelId) panelId = null;
});
