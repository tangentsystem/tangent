// Test fixture: another extension that takes over the browser's connection setting.
chrome.proxy.settings.set({ value: { mode: 'direct' }, scope: 'regular' });
