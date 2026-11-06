#!/usr/bin/env python3
"""ATLAS CPython #93122. Controller + isolated workers; no CPython patching."""
from __future__ import annotations
import argparse
import asyncio
import csv
import hashlib
import inspect
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
import ast
import textwrap
import difflib

TASKS = {}
GROUP = None
EVENT_FILE = None
SEQ = 0

def states():
    result = {}
    for name, task in TASKS.items():
        waiter = getattr(task, '_fut_waiter', None)
        result[name] = {
            'id': id(task), 'type': type(task).__module__ + '.' + type(task).__qualname__,
            'done': task.done(), 'cancelled': task.cancelled(),
            'cancelling': task.cancelling(), 'state': getattr(task, '_state', None),
            'must_cancel': getattr(task, '_must_cancel', None),
            'waiter_exists': waiter is not None,
            'waiter_done': waiter.done() if waiter is not None else None,
            'in_group': task in GROUP._tasks if GROUP is not None else None,
        }
    return result

def emit(marker, **data):
    global SEQ
    SEQ += 1
    record = {'seq': SEQ, 'monotonic_ns': time.monotonic_ns(),
              'marker': marker, 'tasks': states(), **data}
    text = json.dumps(record, sort_keys=True)
    if EVENT_FILE is not None:
        with EVENT_FILE.open('a', encoding='utf8') as f:
            f.write(text + '\n'); f.flush(); os.fsync(f.fileno())
    print('ATLAS_EVENT=' + text, flush=True)

def remember(name):
    TASKS[name] = asyncio.current_task()
    emit(name + '_entered')

async def cooperative(ready, gate):
    remember('peer')
    try:
        ready.set()
        emit('peer_waiting')
        await gate.wait()
    finally:
        emit('cleanup_before')
        await asyncio.sleep(0.01)
        emit('cleanup_after')

async def crasher(exc_type, ready, gate):
    remember('crasher')
    assert ready.is_set()
    peer = TASKS['peer']
    waiter = getattr(peer, '_fut_waiter', None)
    assert not peer.done() and waiter is not None and not waiter.done()
    assert not gate.is_set()
    emit('barrier_verified', peer_started=True, peer_waiting=True)
    emit('raise', exception=exc_type.__name__)
    raise exc_type()

async def original_child(exc_type):
    remember('crasher')
    emit('raise', exception=exc_type.__name__)
    raise exc_type()

async def original_peer():
    remember('peer')
    await asyncio.sleep(0)

async def scenario(case, exc_type):
    global GROUP
    TASKS['parent'] = asyncio.current_task()
    emit('runtime', python=sys.version, executable=sys.executable,
         task_class=asyncio.Task.__module__ + '.' + asyncio.Task.__qualname__,
         asyncio_file=asyncio.__file__, case=case, exception=exc_type.__name__)
    loop = asyncio.get_running_loop()
    async def check():
        assert type(asyncio.current_task()) is asyncio.tasks._PyTask
    checked = loop.create_task(check())
    emit('task_type_verified', exact_py_task=type(checked) is asyncio.tasks._PyTask)
    assert type(checked) is asyncio.tasks._PyTask
    await checked
    if case in ('G', 'G_replay', 'H'):
        await counterexample(case)
        return
    if case in ('a', 'a_single'):
        aws = [original_child(exc_type)]
        if case == 'a':
            aws.append(original_peer())
        await asyncio.gather(*aws)
        return
    ready, gate = asyncio.Event(), asyncio.Event()
    if case == 'b':
        peer = asyncio.create_task(cooperative(ready, gate), name='peer')
        TASKS['peer'] = peer
        await ready.wait()
        await asyncio.gather(crasher(exc_type, ready, gate), peer)
    else:
        if case == 'd':
            loop.set_task_factory(asyncio.eager_task_factory)
        async with asyncio.TaskGroup() as group:
            GROUP = group
            TASKS['peer'] = group.create_task(cooperative(ready, gate), name='peer')
            await ready.wait()
            emit('before_create_crasher')
            TASKS['crasher'] = group.create_task(crasher(exc_type, ready, gate), name='crasher')
            emit('after_create_crasher')
        emit('after_taskgroup')

ESCAPED = set()
KEEP = {}

def special(task, exc):
    key = id(exc)
    KEEP[key] = exc
    repeated = key in ESCAPED
    emit('special_suppressed' if repeated else 'special_escape',
         exception=type(exc).__name__, exception_id=key, task_id=id(task))
    if not repeated:
        ESCAPED.add(key)
    return repeated

def install(variant):
    cls = asyncio.tasks._PyTask
    asyncio.tasks.Task = asyncio.Task = cls
    # The exported factory captured its constructor at import time.
    asyncio.eager_task_factory = asyncio.create_eager_task_factory(cls)
    name = '_Task__step_run_and_handle_result'
    original = getattr(cls, name)
    source = textwrap.dedent(inspect.getsource(original))
    tree = ast.parse(source)
    branches = [n for n in ast.walk(tree) if isinstance(n, ast.ExceptHandler)
                and n.type is not None
                and ast.unparse(n.type) == '(KeyboardInterrupt, SystemExit)']
    assert len(branches) == 1, 'Unsupported special-exception branch'
    branch = branches[0]
    assert branch.name == 'exc'
    assert len(branch.body) == 2
    assert ast.unparse(branch.body[0]) == 'super().set_exception(exc)'
    assert isinstance(branch.body[1], ast.Raise) and branch.body[1].exc is None
    lines = source.splitlines(keepends=True)
    line = branch.body[1].lineno - 1
    indent = lines[line][:len(lines[line]) - len(lines[line].lstrip())]
    assert lines[line].strip() == 'raise'
    patched_lines = lines[:]
    patched_lines[line] = indent + 'if not _atlas_special(self, exc):\n' + indent + '    raise\n'
    patched = ''.join(patched_lines)
    emit('source_evidence', variant=variant, original=source,
         candidate=patched, original_sha256=hashlib.sha256(source.encode()).hexdigest(),
         diff=''.join(difflib.unified_diff(lines, patched_lines)),
         source_file=inspect.getsourcefile(original),
         original_first_line=inspect.getsourcelines(original)[1],
         only_change='replace bare raise inside special branch; other source bytes unchanged')
    if variant == 'H4':
        # Compile in a class to preserve zero-argument super() and private mangling.
        namespace = dict(original.__globals__)
        namespace['_atlas_special'] = special
        wrapped = 'class Task:\n' + textwrap.indent(patched, '    ')
        exec(compile(wrapped, '<atlas-h4-from-inspect>', 'exec'), namespace)
        method = getattr(namespace['Task'], name)
        for cell in method.__closure__ or ():
            if cell.cell_contents is namespace['Task']:
                cell.cell_contents = cls
        setattr(cls, name, method)
    else:
        assert getattr(cls, name) is original

async def counterexample(case):
    first, second = SystemExit(17), SystemExit(23)
    KEEP[id(first)], KEEP[id(second)] = first, second
    async def caught():
        remember('caught')
        try:
            raise first
        except SystemExit as e:
            emit('caught_before_escape', exception_id=id(e))
            emit('cleanup_before')
            await asyncio.sleep(0.01)
            emit('cleanup_after')
            if case == 'G':
                emit('intentional_reraise', exception_id=id(e))
                raise e
    if case in ('G', 'H'):
        await asyncio.create_task(caught())
        if case == 'H':
            async def other():
                remember('second')
                emit('second_distinct_raise', first_id=id(first), exception_id=id(second))
                raise second
            await asyncio.create_task(other())
    else:
        async def initial():
            remember('initial')
            emit('initial_escape_requested', exception_id=id(first))
            raise first
        try:
            await asyncio.gather(initial())
        except SystemExit as e:
            emit('intentional_replay_caught', exception_id=id(e))
            emit('cleanup_before')
            await asyncio.sleep(0.01)
            emit('cleanup_after')
            emit('intentional_reraise', exception_id=id(e))
            raise e

def worker(variant, case, exception, event_path):
    global EVENT_FILE
    EVENT_FILE = Path(event_path)
    try:
        install(variant)
        exc_type = {'SystemExit': SystemExit, 'RuntimeError': RuntimeError,
                    'KeyboardInterrupt': KeyboardInterrupt}[exception]
        asyncio.run(scenario(case, exc_type))
    except BaseException as exc:
        emit('outer_baseexception', exception=type(exc).__name__,
             exception_id=id(exc), exception_repr=repr(exc))
        raise
    finally:
        emit('worker_final_snapshot')

def controller(out):
    out.mkdir(parents=True, exist_ok=True)
    rows = []
    def run(variant, case, exception):
        folder = out / (variant + '-' + case + '-' + exception)
        folder.mkdir()
        events = folder / 'events.jsonl'
        events.touch()
        command = [sys.executable, '-u', str(Path(__file__).resolve()),
                   '--worker', variant, case, exception, str(events.resolve())]
        started = time.monotonic()
        timeout = False
        with (folder / 'stdout.log').open('wb') as stdout, (folder / 'stderr.log').open('wb') as stderr:
            process = subprocess.Popen(command, stdout=stdout, stderr=stderr, start_new_session=True)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                timeout = True
                os.killpg(process.pid, signal.SIGKILL)
                process.wait()
        records = [json.loads(line) for line in events.read_text().splitlines()]
        def count(marker):
            return sum(r['marker'] == marker for r in records)
        outer = [r for r in records if r['marker'] == 'outer_baseexception']
        stderr_text = (folder / 'stderr.log').read_text(errors='replace')
        valid = (not timeout and count('source_evidence') == 1
                 and count('task_type_verified') == 1
                 and count('worker_final_snapshot') == 1
                 and (case not in ('b','c','d') or count('barrier_verified') == 1))
        intentional_ids = {r['exception_id'] for r in records if r['marker'] == 'intentional_reraise'}
        row = dict(variant=variant, case=case, exception=exception,
                   python=sys.version, exitcode=process.returncode, timeout=timeout,
                   duration_seconds=time.monotonic()-started, harness_valid=valid,
                   cleanup_before=count('cleanup_before'), cleanup_after=count('cleanup_after'),
                   outer_count=len(outer), outer_type=outer[0]['exception'] if outer else None,
                   outer_id=outer[0]['exception_id'] if outer else None,
                   pending_warning='Task was destroyed but it is pending' in stderr_text,
                   special_escapes=count('special_escape'), special_suppressed=count('special_suppressed'),
                   intentional_suppressed=any(r['marker']=='special_suppressed' and
                       r['exception_id'] in intentional_ids for r in records),
                   command=command, last_snapshot=records[-1] if records else None)
        if case == 'H':
            second = next((r for r in records if r['marker']=='second_distinct_raise'), None)
            row['distinct_second_reaches_outer'] = bool(second and second['exception_id'] != second['first_id']
                and len(outer)==1 and outer[0]['exception_id']==second['exception_id'])
        rows.append(row)
        (folder / 'result.json').write_text(json.dumps(row, indent=2))
        print(json.dumps(row), flush=True)
        return row
    status = 'INCOMPLETE'
    checks = {}
    try:
        base = run('BASE', 'b', 'SystemExit')
        checks['baseline_reproduced'] = (base['harness_valid'] and base['cleanup_before']==1
            and base['cleanup_after']==0 and base['pending_warning']
            and base['outer_count']==1 and base['outer_type']=='SystemExit')
        if not checks['baseline_reproduced']:
            status = 'ABORTED_BASELINE_NOT_REPRODUCED'
            return 2
        h4 = run('H4', 'b', 'SystemExit')
        checks['h4_b'] = (h4['harness_valid'] and h4['cleanup_before']==1 and h4['cleanup_after']==1
            and h4['outer_count']==1 and h4['outer_type']=='SystemExit'
            and not h4['pending_warning'] and h4['exitcode']==base['exitcode'])
        specs = [(c,e) for c in ('a','c','d') for e in ('SystemExit','RuntimeError')]
        specs += [('b','RuntimeError'), ('b','KeyboardInterrupt'), ('G','SystemExit'),
                  ('H','SystemExit'), ('G_replay','SystemExit')]
        for case, exception in specs:
            b = run('BASE',case,exception)
            h = run('H4',case,exception)
            ok = (b['harness_valid'] and h['harness_valid']
                and b['exitcode']==h['exitcode'] and b['outer_type']==h['outer_type']
                and b['outer_count']==h['outer_count']
                and h['cleanup_before']>=b['cleanup_before']
                and h['cleanup_after']>=b['cleanup_after']
                and (not h['pending_warning'] or b['pending_warning']))
            if case=='H':
                ok = ok and h['distinct_second_reaches_outer']
            checks[case+'-'+exception] = ok
        checks['all_harnesses_valid'] = all(r['harness_valid'] for r in rows)
        weakness = any(r['variant']=='H4' and r['intentional_suppressed'] for r in rows)
        status = 'H4_WEAKNESS_INTENTIONAL_REPROPAGATION_SUPPRESSED' if weakness else 'EXECUTED'
        return 0 if all(checks.values()) and not weakness else 1
    finally:
        report = dict(status=status, checks=checks, cases=rows, python=sys.version,
                      github_sha=os.getenv('GITHUB_SHA'),
                      script_sha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                      notes=['BASE method unmodified; H4 changes only special-branch raise.',
                             'G catches before first task escape; G_replay intentionally rethrows an already escaped object.',
                             'H retains both distinct objects; first is caught and never escapes.',
                             'Identity IDs are process-local; strong references prevent ID reuse.',
                             'Snapshots never retrieve task exceptions.',
                             'No results exist until the manually dispatched workflow runs.'])
        (out/'report.json').write_text(json.dumps(report,indent=2))
        fields = ['variant','case','exception','exitcode','timeout','harness_valid','cleanup_before',
                  'cleanup_after','outer_count','outer_type','pending_warning',
                  'special_escapes','special_suppressed','intentional_suppressed']
        with (out/'table.csv').open('w',newline='') as f:
            w=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore')
            w.writeheader()
            w.writerows(rows)

if __name__ == '__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--worker':
        worker(*sys.argv[2:])
    else:
        parser=argparse.ArgumentParser()
        parser.add_argument('--out',type=Path,required=True)
        sys.exit(controller(parser.parse_args().out))
