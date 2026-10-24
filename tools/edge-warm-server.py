"""Warm edge-tts worker for the voice stack.

The CLI starts a fresh Python process for every fragment, which costs about two
seconds each time. This worker imports edge_tts once and answers over HTTP, so a
fragment is synthesized without that startup cost.

POST /tts  {"text": "...", "voice": "ru-RU-SvetlanaNeural"}  -> audio/mpeg
GET  /health -> {"ok": true, "voice": "..."}

Loopback only. One asyncio loop owns everything, because edge_tts keeps aiohttp
sessions bound to the loop that created them.
"""

from __future__ import annotations

import json

import edge_tts
from aiohttp import web

HOST = "127.0.0.1"
PORT = 8899
DEFAULT_VOICE = "ru-RU-SvetlanaNeural"

# Counts answered requests, so it is provable that speech goes through this worker
# rather than through a fresh CLI process.
_stats = {"requests": 0, "chars": 0}


async def synthesize(text: str, voice: str) -> bytes:
    data = bytearray()
    communicate = edge_tts.Communicate(text, voice)
    async for chunk in communicate.stream():
        if chunk.get("type") == "audio" and chunk.get("data"):
            data.extend(chunk["data"])
    return bytes(data)


async def handle_tts(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    text = str(body.get("text") or "").strip()
    voice = str(body.get("voice") or DEFAULT_VOICE)
    if not text:
        return web.json_response({"ok": False, "error": "empty text"}, status=400)
    try:
        audio = await synthesize(text, voice)
    except Exception as error:  # noqa: BLE001 - report instead of dying
        return web.json_response({"ok": False, "error": str(error)[:200]}, status=502)
    if len(audio) < 32:
        return web.json_response({"ok": False, "error": "empty audio"}, status=502)
    _stats["requests"] += 1
    _stats["chars"] += len(text)
    return web.Response(body=audio, content_type="audio/mpeg")


async def handle_tts_stream(request: web.Request) -> web.StreamResponse:
    """Отдаём mp3 кусками по мере синтеза, не дожидаясь конца фразы.

    В отличие от /tts, ответ уходит частями (chunked): клиент может начать
    декодировать и играть, пока синтез ещё идёт.
    """
    try:
        body = await request.json()
    except Exception:
        return web.json_response({"ok": False, "error": "bad json"}, status=400)
    text = str(body.get("text") or "").strip()
    voice = str(body.get("voice") or DEFAULT_VOICE)
    if not text:
        return web.json_response({"ok": False, "error": "empty text"}, status=400)

    response = web.StreamResponse(
        headers={"Content-Type": "audio/mpeg", "Cache-Control": "no-store"}
    )
    await response.prepare(request)

    sent = 0
    try:
        communicate = edge_tts.Communicate(text, voice)
        async for chunk in communicate.stream():
            if chunk.get("type") != "audio":
                continue
            data = chunk.get("data") or b""
            if not data:
                continue
            await response.write(data)
            sent += len(data)
    except Exception as error:  # noqa: BLE001 - сообщаем клиенту, а не падаем
        # Заголовки уже отправлены, поэтому ошибку видно только по обрыву.
        print(json.dumps({"ok": False, "error": str(error)[:200]}), flush=True)

    if sent >= 32:
        _stats["requests"] += 1
        _stats["chars"] += len(text)
    await response.write_eof()
    return response


async def handle_health(_request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "voice": DEFAULT_VOICE, **_stats})


def main() -> None:
    import sys

    port = PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            port = PORT
    app = web.Application(client_max_size=1024 * 1024)
    app.router.add_post("/tts", handle_tts)
    app.router.add_post("/tts-stream", handle_tts_stream)
    app.router.add_get("/health", handle_health)
    print(json.dumps({"ok": True, "message": f"edge warm worker on {HOST}:{port}"}), flush=True)
    web.run_app(app, host=HOST, port=port, print=None)


if __name__ == "__main__":
    main()
