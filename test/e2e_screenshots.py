#!/usr/bin/env python3
import base64
import json
import os
import pathlib
import re
import subprocess
import time
import urllib.request
from websocket import create_connection

ROOT = pathlib.Path('/mnt/data/Testchay-recovered')
OUT = ROOT / 'docs' / 'test-evidence'
OUT.mkdir(parents=True, exist_ok=True)
PORT = 9333
PROFILE = '/tmp/testchay-chrome-profile'

subprocess.run(['rm', '-rf', PROFILE], check=False)
chrome = subprocess.Popen([
    '/usr/bin/chromium', '--headless=new', '--no-sandbox', '--disable-gpu',
    '--disable-dev-shm-usage', '--remote-allow-origins=*', f'--remote-debugging-port={PORT}',
    f'--user-data-dir={PROFILE}', '--window-size=1440,900',
    'about:blank'
], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_json(url, timeout=10):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(url, timeout=1) as response:
                return json.load(response)
        except Exception:
            time.sleep(0.1)
    raise RuntimeError(f'timeout: {url}')


tabs = wait_json(f'http://127.0.0.1:{PORT}/json')
tab = next(item for item in tabs if item.get('type') == 'page')
os.environ['NO_PROXY'] = '127.0.0.1,localhost'
ws = create_connection(tab['webSocketDebuggerUrl'], timeout=5, http_proxy_host=None, http_proxy_port=None)
sequence = 0
events = []


def command(method, params=None, timeout=8):
    global sequence
    sequence += 1
    ident = sequence
    ws.send(json.dumps({'id': ident, 'method': method, 'params': params or {}}))
    deadline = time.time() + timeout
    while time.time() < deadline:
        payload = json.loads(ws.recv())
        if payload.get('id') == ident:
            if 'error' in payload:
                raise RuntimeError(payload['error'])
            return payload.get('result', {})
        events.append(payload)
    raise RuntimeError(f'CDP timeout: {method}')


def evaluate(expression, await_promise=False):
    result = command('Runtime.evaluate', {
        'expression': expression,
        'returnByValue': True,
        'awaitPromise': await_promise,
        'userGesture': True,
    })
    if result.get('exceptionDetails'):
        raise RuntimeError(result['exceptionDetails'])
    return result.get('result', {}).get('value')


def wait_js(expression, timeout=12):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if evaluate(expression):
                return
        except Exception:
            pass
        time.sleep(0.15)
    raise RuntimeError(f'wait_js timeout: {expression}')


def screenshot(name):
    data = command('Page.captureScreenshot', {'format': 'png', 'captureBeyondViewport': False})['data']
    path = OUT / name
    path.write_bytes(base64.b64decode(data))
    return path


try:
    command('Page.enable')
    command('Runtime.enable')
    command('Network.enable')

    public = ROOT / 'public'
    html = (public / 'index.html').read_text(encoding='utf-8')
    html = re.sub(r'<script type="module" src="/app.js"></script>', '', html)
    frame_id = command('Page.getFrameTree')['frameTree']['frame']['id']
    command('Page.setDocumentContent', {'frameId': frame_id, 'html': html})
    core = (public / 'client-core.js').read_text(encoding='utf-8')
    core = core.replace('export const ', 'const ').replace('export function ', 'function ')
    app_source = (public / 'app.js').read_text(encoding='utf-8')
    app_source = re.sub(r"import \{[\s\S]*?\} from './client-core.js';\n", '', app_source, count=1)
    app_source = app_source.replace('let state = null;', "let state = null; Object.defineProperty(globalThis, '__testState', {get: () => state});")
    app_source = app_source.replace(
        "socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);",
        "socket = new WebSocket('ws://127.0.0.1:4173/ws'); globalThis.__testSocket = socket;",
    )
    evaluate(core + '\n' + app_source)
    wait_js("document.readyState === 'complete' && !document.querySelector('#connection').classList.contains('show')")
    screenshot('01-home-desktop.png')

    evaluate("""
      (() => {
        const input = document.querySelector('input[name=name]');
        input.value = 'Test Captain';
        input.dispatchEvent(new Event('input', {bubbles:true}));
        document.querySelector('#room-form').requestSubmit();
      })()
    """)
    wait_js("document.querySelector('#room-code') && document.querySelectorAll('.player').length === 1")
    for _ in range(3):
        evaluate("document.querySelector('#add-bot').click()")
        time.sleep(0.25)
    wait_js("document.querySelectorAll('.player').length === 4")
    wait_js("document.querySelector('#toast').hidden", timeout=4)
    room_code = evaluate("document.querySelector('#room-code').textContent")
    screenshot('02-lobby-four-players.png')

    evaluate("document.querySelector('#start-game').click()")
    wait_js("document.body.classList.contains('playing')")
    screenshot('03-countdown-desktop.png')
    wait_js("document.querySelector('#timer') && document.querySelector('#timer').textContent.includes('s')", timeout=5)

    evaluate("""
      document.querySelectorAll('[data-action]').forEach((button, index) => {
        button.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, pointerId:index+1}));
      })
    """)
    time.sleep(1.5)
    screenshot('04-gameplay-desktop.png')

    evaluate("globalThis.__testSocket.close()")
    wait_js("document.querySelector('#connection').classList.contains('show')", timeout=4)
    wait_js("document.body.classList.contains('playing') && !document.querySelector('#connection').classList.contains('show')", timeout=8)
    screenshot('05-gameplay-after-reconnect.png')

    command('Emulation.setDeviceMetricsOverride', {
        'width': 844, 'height': 390, 'deviceScaleFactor': 1,
        'mobile': True, 'screenWidth': 844, 'screenHeight': 390,
    })
    time.sleep(0.4)
    screenshot('06-gameplay-mobile-landscape.png')

    try:
        finish_deadline = time.time() + 18
        while time.time() < finish_deadline and not evaluate("!!document.querySelector('.result')"):
            evaluate("""
              document.querySelectorAll('[data-action]:not(.active)').forEach((button, index) => {
                button.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, pointerId:index+10}));
              })
            """)
            time.sleep(0.25)
        wait_js("!!document.querySelector('.result')", timeout=1)
    except Exception:
        diagnostics = {
            'state': evaluate('globalThis.__testState'),
            'body': evaluate('document.body.innerText'),
            'connectionClass': evaluate("document.querySelector('#connection').className"),
            'socketState': evaluate('globalThis.__testSocket?.readyState'),
        }
        (OUT / 'failure-diagnostics.json').write_text(json.dumps(diagnostics, ensure_ascii=False, indent=2), encoding='utf-8')
        screenshot('99-failure-state.png')
        raise
    wait_js("document.querySelector('#toast').hidden", timeout=4)
    result_fits_mobile = evaluate("(() => { const r=document.querySelector('.result').getBoundingClientRect(); const b=document.querySelector('#rematch')?.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && (!b || b.bottom <= innerHeight); })()")
    if not result_fits_mobile:
        raise RuntimeError('mobile result card does not fit inside the landscape viewport')
    screenshot('07-result-mobile.png')

    command('Emulation.clearDeviceMetricsOverride')
    time.sleep(0.3)
    desktop_has_no_scroll = evaluate('document.documentElement.scrollHeight <= innerHeight + 1')
    if not desktop_has_no_scroll:
        raise RuntimeError('desktop result page has unnecessary vertical scrolling')
    screenshot('08-result-desktop.png')

    exceptions = [event for event in events if event.get('method') == 'Runtime.exceptionThrown']
    exception_details = []
    for event in exceptions:
        details = event.get('params', {}).get('exceptionDetails', {})
        exception = details.get('exception', {})
        exception_details.append(exception.get('description') or details.get('text') or 'Unknown exception')
    report = {
        'screenshots': [path.name for path in sorted(OUT.glob('*.png'))],
        'javascriptExceptions': len(exceptions),
        'exceptionDetails': exception_details,
        'roomCode': room_code,
        'resultTitle': evaluate("document.querySelector('.result h1')?.textContent || null"),
        'resultScore': evaluate("document.querySelector('.score')?.textContent || null"),
    }
    (OUT / 'browser-report.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(report, ensure_ascii=False, indent=2))
finally:
    try:
        ws.close()
    except Exception:
        pass
    chrome.terminate()
    try:
        chrome.wait(timeout=3)
    except subprocess.TimeoutExpired:
        chrome.kill()
