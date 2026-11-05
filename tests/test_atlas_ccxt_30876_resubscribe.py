"""Offline resubscribe regression for CCXT #30876; run with Python 3.12.

Only WebSocket I/O, the REST snapshot failure, and the synthetic book decoder
are simulated. Client lifecycle, watch(), futures and registry are real CCXT.
"""
import argparse
import asyncio
import inspect
import json
from pathlib import Path
import sys
import textwrap
import types
import unittest
from unittest.mock import patch

import ccxt
import ccxt.pro
from aiohttp import WSMessage, WSMsgType
from ccxt.async_support.base.ws.client import Client

URL = 'wss://atlas.invalid/shared'
SYMBOLS = ('A/USDT:USDT', 'B/USDT:USDT')
OLD = """        client.reject(error, messageHash)
        if client.error is None:
            client.error = error  # on_close must not treat this as a server disconnect
        asyncio.ensure_future(client.close())
        if self.clients.get(client.url) is client:
            del self.clients[client.url]
"""


class FakeSocket:
    _conn = None  # Client.buffer: no aiohttp buffered frames

    def __init__(self):
        self.closed = False
        self.inbound = asyncio.Queue()
        self.sent = []
        self.closed_event = asyncio.Event()

    async def send_str(self, data):
        if self.closed:
            raise ConnectionError('closed fake transport')
        self.sent.append(json.loads(data))

    async def receive(self):
        return await self.inbound.get()

    async def close(self):
        if not self.closed:
            self.closed = True
            self.closed_event.set()
            self.inbound.put_nowait(WSMessage(WSMsgType.CLOSE, 1000, ''))

    def deliver(self, book):
        assert not self.closed, 'cannot deliver on old transport'
        self.inbound.put_nowait(WSMessage(WSMsgType.TEXT, json.dumps(book), ''))


async def until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(0.001)


def apply_variant(exchange, variant):
    function = exchange.load_order_book.__func__
    source = inspect.getsource(function)
    assert source.count(OLD) == 1, 'SOURCE_DRIFT: pinned failure path changed'
    if variant == 'original':
        return  # no modification at all
    replacement = OLD.replace('        client.reject(error, messageHash)\n',
                              '        client.reject(error, messageHash)\n'
                              '        client.reject(error)\n', 1)
    namespace = {}
    exec(compile(textwrap.dedent(source.replace(OLD, replacement, 1)),
                 '<CCXT 4.5.88 + one line>', 'exec'), function.__globals__, namespace)
    exchange.load_order_book = types.MethodType(namespace['load_order_book'], exchange)


async def scenario(variant):
    exchange = ccxt.pro.kucoinfutures({'enableRateLimit': False,
                                      'options': {'ws': {'keepAlive': 0}}})
    apply_variant(exchange, variant)
    clients = []
    sockets = []
    tasks = []
    outcomes = {}
    observations = {}

    async def connect(client, session):
        transport = FakeSocket()
        clients.append(client)
        sockets.append(transport)
        return transport

    def decode(client, message):
        # Synthetic book protocol, intentionally not a KuCoin wire decoder.
        client.resolve(message, 'orderbook:' + message['symbol'])

    async def fail_snapshot(*args, **kwargs):
        raise ccxt.RateLimitExceeded('ATLAS injected HTTP 429')

    async def watch(symbol):
        try:
            value = await exchange.watch(URL, 'orderbook:' + symbol,
                                         {'subscribe': symbol}, 'orderbook:' + symbol)
            return {'kind': 'data', 'value': value}
        except asyncio.CancelledError:
            return {'kind': 'CancelledError'}
        except Exception as error:
            return {'kind': type(error).__name__, 'catchable': True}

    exchange.handle_message = decode
    exchange.fetch_rest_order_book_safe = fail_snapshot
    try:
        with patch.object(Client, 'create_connection', connect):
            first = [asyncio.create_task(watch(symbol)) for symbol in SYMBOLS]
            tasks.extend(first)
            await until(lambda: len(sockets) == 1 and len(sockets[0].sent) == 2)
            old = exchange.clients[URL]
            assert all('orderbook:' + symbol in old.futures for symbol in SYMBOLS)
            assert len(clients) == 1, 'watchers must share one client'
            exchange.orderbooks[SYMBOLS[0]] = exchange.order_book({})
            await exchange.load_order_book(old, 'orderbook:' + SYMBOLS[0], SYMBOLS[0])
            await until(lambda: all(task.done() for task in first) and sockets[0].closed)
            initial = [task.result() for task in first]
            outcomes['E1'] = all(item.get('catchable') is True and
                                 item['kind'] == 'RateLimitExceeded' for item in initial)
            outcomes['E2'] = sockets[0].closed
            observations['initial_watchers'] = initial
            observations['old_futures_after_error'] = list(old.futures)
            observations['registry_after_error'] = list(exchange.clients)

            # Deliberately retry both even for the failing original variant. The
            # CancelledError was recorded, not reclassified as a catchable error.
            second = [asyncio.create_task(watch(symbol)) for symbol in SYMBOLS]
            tasks.extend(second)
            await until(lambda: len(sockets) == 2 and len(sockets[1].sent) == 2)
            current = exchange.clients[URL]
            assert current is not old and current is clients[1]
            assert not sockets[1].closed
            fresh = [{'symbol': symbol, 'nonce': 200 + index,
                      'bids': [[100 + index, 2]], 'asks': [[102 + index, 3]]}
                     for index, symbol in enumerate(SYMBOLS)]
            for book in fresh:
                sockets[1].deliver(book)
            await until(lambda: all(task.done() for task in second))
            received = [task.result() for task in second]
            outcomes['E3'] = received == [{'kind': 'data', 'value': book} for book in fresh]
            observations['resubscribed_watchers'] = received

            # Measure BEFORE global cleanup, including detached clients. Then
            # require the registry to be empty after normal exchange shutdown.
            clean_futures = all(not client.futures and not client.rejections for client in clients)
            live_registry = (len(exchange.clients) == 1 and
                             exchange.clients.get(URL) is current and
                             not current.closed() and current.error is None)
            observations['futures_before_shutdown'] = [list(client.futures) for client in clients]
            await exchange.close()
            await asyncio.sleep(0)
            outcomes['E4'] = (clean_futures and live_registry and not exchange.clients and
                               all(not client.futures and not client.rejections for client in clients)
                               and all(socket.closed for socket in sockets))
            observations['registry_after_shutdown'] = list(exchange.clients)
    finally:
        # Do not clear registries/futures to manufacture E4 success.
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await exchange.close()
        for client in clients:
            await client.close()
        await asyncio.sleep(0)
    return {'variant': variant, 'expectations': outcomes, 'observations': observations}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--variant', required=True, choices=['original', 'one-line'])
    parser.add_argument('--output-dir', default='results')
    args = parser.parse_args()
    assert sys.version_info[:2] == (3, 12), sys.version
    assert ccxt.__version__ == '4.5.88', ccxt.__version__
    report = asyncio.run(scenario(args.variant))
    destination = Path(args.output_dir)
    destination.mkdir(parents=True, exist_ok=True)
    (destination / (args.variant + '.json')).write_text(json.dumps(report, indent=2) + '\n')
    row = '| ' + args.variant + ' | ' + ' | '.join(
        'PASS' if report['expectations'][key] else 'FAIL' for key in ('E1', 'E2', 'E3', 'E4')) + ' |\n'
    (destination / (args.variant + '.md')).write_text(row)
    print(json.dumps(report, sort_keys=True), flush=True)

    class Expectations(unittest.TestCase):
        pass

    for key, passed in report['expectations'].items():
        def check(self, key=key, passed=passed):
            self.assertTrue(passed, f'{args.variant} {key}: {report["observations"]}')
        setattr(Expectations, 'test_' + key, check)
    result = unittest.TextTestRunner(verbosity=2).run(unittest.defaultTestLoader.loadTestsFromTestCase(Expectations))
    return 0 if result.wasSuccessful() else 1


if __name__ == '__main__':
    sys.exit(main())
