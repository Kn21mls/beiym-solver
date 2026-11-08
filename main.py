from __future__ import annotations

import argparse
import json
import threading

from beyim_solver.core import Ollama, Question, Settings, SolverError


def main():
    parser = argparse.ArgumentParser(description="Beyim Solver — локальный решатель Ollama")
    parser.add_argument("--doctor", action="store_true", help="Проверить Ollama и список моделей")
    parser.add_argument("--smoke-test", action="store_true", help="Проверить решение простого уравнения реальной моделью")
    args = parser.parse_args()
    if not (args.doctor or args.smoke_test):
        from beyim_solver.gui import main as gui
        gui()
        return
    try:
        settings = Settings.load()
        client = Ollama(settings)
        models = client.models()
        print("Ollama:", settings.ollama_url)
        print("Модели:", ", ".join(models))
        if settings.model not in models:
            raise SolverError(f"Сначала выполните: ollama pull {settings.model}")
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
