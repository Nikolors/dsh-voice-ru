# Патч 3. Микрофон сам переподключается после смены устройств

**Файл:** `lib/client.js` плагина разговорного режима.

## Проблема

После сеанса удалённого рабочего стола (телефон, RDP) на компьютере
появляются и исчезают звуковые устройства. Поток микрофона при этом
становится мёртвым: индикатор уровней показывает нули, фразы не
распознаются. Помогала только перезагрузка приложения.

## Лечение

Слушаем `devicechange` и один раз (с задержкой) перезапускаем движок:

```js
let deviceRestartTimer = null;

try {
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => {
      if (engine.state === 'off' || micMuted) return;
      log('audio devices changed - reopening microphone');
      if (deviceRestartTimer) clearTimeout(deviceRestartTimer);
      deviceRestartTimer = setTimeout(() => {
        deviceRestartTimer = null;
        if (engine.state === 'off' || micMuted) return;
        if (ticker) { clearInterval(ticker); ticker = null; }
        try { closeMic(); } catch (_e) {}
        start().catch((error) => {
          log(`mic restart after device change failed: ${error && error.message}`);
        });
      }, 1200);
    });
  }
} catch (_) {}
```

Задержка нужна потому, что при подключении устройства приходят несколько
событий подряд.

## Проверка

1. Подключиться с телефона по удалённому столу, сказать фразу.
2. Отключиться, вернуться за компьютер, сказать фразу — **без** перезапуска
   приложения и без Ctrl+M она должна распознаться.
3. В журнале при этом появляется `audio devices changed - reopening microphone`.
