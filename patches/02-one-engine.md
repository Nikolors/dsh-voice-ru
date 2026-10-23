# Патч 2. Один движок и защита от дублей

**Файл:** `lib/client.js` плагина разговорного режима.

## Проблема

После перезапусков приложения в странице оставались старые копии движка.
Каждая писала в журнал и слушала микрофон — в итоге одна фраза уходила
в чат три-четыре раза подряд (`submit called` несколько раз в журнале),
а в трассировке перебивания одновременно виднелись разные пороги.

## Лечение 1: один движок на страницу

```js
const ENGINE_ID = Math.random().toString(36).slice(2) + Date.now().toString(36);
const ENGINE_KEY = 'dsh-voice-engine';
let engineWatch = null;

function claimEngine() {
  try {
    const now = Date.now();
    let other = null;
    try { other = JSON.parse(localStorage.getItem(ENGINE_KEY) || 'null'); } catch (_e) {}
    if (other && other.id !== ENGINE_ID && now - other.at < 4000) return false;
    localStorage.setItem(ENGINE_KEY, JSON.stringify({ id: ENGINE_ID, at: now }));
    return true;
  } catch (_e) {
    return true;   // без localStorage не мешаем работать
  }
}

function retireEngine() {
  log('another engine is active - this one retires quietly');
  if (ticker) clearInterval(ticker);
  ticker = null;
  if (engineWatch) clearInterval(engineWatch);
  engineWatch = null;
  try { closeMic(); } catch (_e) {}
}
```

В `start()` после запуска тикера:

```js
claimEngine();
if (engineWatch) clearInterval(engineWatch);
engineWatch = setInterval(() => {
  if (!claimEngine()) retireEngine();
}, 2000);
```

Старый движок тихо уходит и не публикует «режим выключен», иначе он погасил
бы новый.

## Лечение 2: не отправлять одну и ту же фразу дважды

Перед отправкой:

```js
const submitAt = Date.now();
if (lastSubmit && lastSubmit.text === text && submitAt - lastSubmit.at < 5000) {
  log(`duplicate transcript ignored: "${text.slice(0, 60)}"`);
  engine.set('listening');
  return;
}
lastSubmit = { text, at: submitAt };
```

## Проверка

Сказать одну фразу. В журнале должен быть **один** `submit called`
и одна запись `transcript`.
