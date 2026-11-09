"""Bound resources for local inference, including concurrent app instances."""
import os
import threading
from contextlib import contextmanager

from .core import ROOT, SolverError

_lock = threading.Lock()


@contextmanager
def inference_slot():
    if not _lock.acquire(blocking=False):
        raise SolverError("Решение уже выполняется. Дождитесь завершения текущего запроса.")
    handle = None
    locked = False
    try:
        path = ROOT / '.state' / 'inference.lock'
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = path.open('a+b')
        handle.write(b'0') if path.stat().st_size == 0 else None
        handle.flush()
        handle.seek(0)
        try:
            if os.name == 'nt':
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            locked = True
        except OSError as exc:
            raise SolverError("Другое окно Beyim Solver уже решает задание. Дождитесь завершения.") from exc
        yield
    finally:
        if handle:
            if locked:
                handle.seek(0)
                if os.name == 'nt':
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            handle.close()
        _lock.release()
