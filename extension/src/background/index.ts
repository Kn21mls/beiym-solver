import browser from 'webextension-polyfill';
import { betaApi, safari } from '../shared/beta-config';
import type { CaptureRequest, CaptureResponse } from '../shared/messages';

let panelId: number | null = null;
let panelTab: number | undefined;
let sourceTab: number | undefined;

async function capture(tab: browser.Tabs.Tab | undefined): Promise<CaptureResponse> {
  if (!tab || tab.id === undefined || tab.windowId === undefined) {
    return { ok: false, error: 'Не удалось определить вкладку Beyim.' };
  }
  try {
    if (typeof browser.tabs.captureVisibleTab !== 'function') {
      return { ok: false, error: 'Эта версия Safari не поддерживает снимок вкладки для этого рисунка.' };
    }
    if (!tab.active && !safari) {
      await browser.tabs.update(tab.id, { active: true });
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const [active] = await browser.tabs.query({ windowId: tab.windowId, active: true });
    if (active?.id !== tab.id || active.url !== tab.url) {
      return { ok: false, error: 'Вернитесь к заданию Beyim и повторите разбор.' };
    }
    const dataUrl = await browser.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const [captured] = await browser.tabs.query({ windowId: tab.windowId, active: true });
    if (captured?.id !== tab.id || captured.url !== tab.url) {
      return { ok: false, error: 'Вернитесь к заданию Beyim и повторите разбор.' };
    }
    return { ok: true, dataUrl };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/activeTab|all_urls|permission/i.test(message)) {
      return { ok: false, error: 'Откройте панель с активной вкладки Beyim и повторите.' };
    }
    return { ok: false, error: message };
  }
}

async function openPanel(tab?: browser.Tabs.Tab): Promise<void> {
  const tabId = betaApi ? tab?.id : undefined;
  const url = browser.runtime.getURL('panel.html') + (tabId === undefined ? '' : '?tab=' + tabId);
  if (panelId !== null) {
    try {
      if (panelTab !== undefined && sourceTab !== tabId && tabId !== undefined) {
        await browser.tabs.update(panelTab, { url });
        sourceTab = tabId;
      }
      await browser.windows.update(panelId, { focused: true });
      return;
    } catch {
      panelId = null;
    }
  }
  try {
    const created = await browser.windows.create({ url, type: 'popup', width: 480, height: 820 });
    panelId = created.id ?? null;
    panelTab = created.tabs?.[0]?.id;
    sourceTab = tabId;
  } catch {
    await browser.tabs.create({ url });
  }
}

if (!safari) {
  browser.action.onClicked.addListener((tab) => {
    void openPanel(tab);
  });
  if (betaApi) {
    browser.runtime.onInstalled.addListener(({ reason }) => {
      if (reason === 'install') void openPanel();
    });
  }
  browser.windows.onRemoved.addListener((id) => {
    if (id === panelId) panelId = null;
  });
}

browser.runtime.onMessage.addListener((message: unknown, sender: browser.Runtime.MessageSender) => {
  const incoming = message as Partial<CaptureRequest>;
  if (!incoming || incoming.type !== 'capture') return undefined;
  return capture(sender.tab);
});
