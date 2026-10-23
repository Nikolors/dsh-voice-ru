# Патч 1. Ctrl+M — выключить микрофон, не выходя из режима

**Файл:** `lib/client.js` в плагине разговорного режима
(`.dsh/profiles/desktop/node_modules/@goodandready/dsh-voice/lib/client.js`)

**Зачем:** в разговорном режиме микрофон слушает всегда. Нужен способ быстро
«оглохнуть», когда рядом люди, но не выключать режим и озвучку.

## Что добавить

Рядом с состоянием движка:

```js
let micMuted = false; // микрофон выключен, режим и озвучка работают
let deviceRestartTimer = null;
```

Функция переключения (рядом со `stop()`):

```js
async function toggleMicMute() {
  if (!micMuted) {
    micMuted = true;
    const wasActive = engine.state !== 'off';
    try { releaseRecording('microphone muted'); } catch (_e) {}
    try { closeMic(); } catch (_e) {}
    if (wasActive) {
      engine.set('listening');
      if (!ticker) ticker = setInterval(tick, TUNE.tickMs);
    }
    log('microphone muted (Ctrl+M)');
    try { engine.touch(); } catch (_e) {}
    return;
  }
  micMuted = false;
  try {
    if (ticker) { clearInterval(ticker); ticker = null; }
    try { closeMic(); } catch (_e) {}
    await start();               // полный перезапуск движка
    log(`microphone unmuted (Ctrl+M), состояние ${engine.state}`);
    try { engine.touch(); } catch (_e) {}
  } catch (error) {
    log(`microphone reopen failed: ${error && error.message}`);
  }
}
```

Обработчик клавиши — **в фазе перехвата**, иначе поле ввода съедает событие:

```js
let muteKeyBusy = false;
const onMuteKey = (event) => {
  const key = (event.key || '').toLowerCase();
  const isMute = (event.ctrlKey || event.metaKey)
    && (key === 'm' || key === 'ь' || event.code === 'KeyM');
  if (!isMute || muteKeyBusy) return;
  muteKeyBusy = true;
  setTimeout(() => { muteKeyBusy = false; }, 250);
  event.preventDefault();
  event.stopPropagation();
  toggleMicMute().catch(() => {});
};
document.addEventListener('keydown', onMuteKey, true);
```

**Важно:** не вешать два обработчика (на `document` и на `window`) — событие
дойдёт до обоих, и микрофон включится сразу после выключения.

## Подпись в интерфейсе

В месте, где собирается текст плашки:

```js
const label = ... : (micMuted ? 'Микрофон выключен' : (LABELS[state] || 'Разговор'));
```

И не забыть `engine.touch()` после переключения, чтобы плашка обновилась.
