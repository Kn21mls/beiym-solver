from __future__ import annotations

import argparse
import json
import os
import threading
import sys
import subprocess
from pathlib import Path

from beyim_solver.cloud import create_client, selected_model
from beyim_solver.core import Question, Settings, SolverError


def main():
    # Double-clicking main.py may otherwise use the system's unrelated Python.
    scripts, exe = ('Scripts', 'python.exe') if os.name == 'nt' else ('bin', 'python')
    interpreter = Path(__file__).resolve().parent / '.venv' / scripts / exe
    if interpreter.exists() and Path(sys.executable).resolve() != interpreter.resolve():
        raise SystemExit(subprocess.call([str(interpreter), str(Path(__file__).resolve()), *sys.argv[1:]]))
    parser = argparse.ArgumentParser(description="Beyim Solver — OpenRouter / Groq / Ollama")
    parser.add_argument("--doctor", action="store_true", help="Проверить выбранный сервис и список моделей")
    parser.add_argument("--smoke-test", action="store_true", help="Проверить решение простого уравнения реальной моделью")
    parser.add_argument("--vision-smoke-test", action="store_true", help="Проверить полный цикл на локальном задании с рисунком")
    parser.add_argument("--full-smoke-test", action="store_true", help="Текст -> рисунок -> текст и освобождение памяти")
    parser.add_argument("--provider", choices=("openrouter", "groq", "ollama"), help="Сервис для проверки без изменения config.json")
    args = parser.parse_args()
    if args.vision_smoke_test or args.full_smoke_test:
        from beyim_solver.verification import check_vision
        try:
            check_vision(full=args.full_smoke_test, provider=args.provider)
        except SolverError as exc:
            print(str(exc))
            raise SystemExit(1)
        return
    if not (args.doctor or args.smoke_test):
        from beyim_solver.gui import main as gui
        gui()
        return
    try:
        settings = Settings.load()
        if args.provider:
            settings.provider = args.provider
        client = create_client(settings)
        models = client.models()
        print("Сервис:", settings.provider)
        if len(models) <= 50:
            print("Модели:", ", ".join(models))
        else:
            print(f"Моделей: {len(models)}. Полный список доступен в окне приложения.")
        print("Выбрана:", selected_model(settings))
        if selected_model(settings) not in models:
            raise SolverError(f"Модель {selected_model(settings)} недоступна для выбранного сервиса.")
        if args.smoke_test:
            q = Question("Реши уравнение 3x + 7 = 22. Чему равен x?", [
                {"text": "3"}, {"text": "5"}, {"text": "7"}], "single")
            result = client.solve(q, threading.Event())
            print(json.dumps(result, ensure_ascii=False, indent=2))
            if result["answer_ids"] != [2]:
                raise SolverError("Модель ошиблась в контрольном примере.")
            print("Контрольное задание решено верно.")
    except SolverError as exc:
        print(str(exc))
        raise SystemExit(1)


if __name__ == "__main__":
    main()
