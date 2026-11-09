from __future__ import annotations

import queue
import logging
from logging.handlers import RotatingFileHandler
import threading
import time
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk

from .browser import Browser, Runner
from .cloud import create_client, selected_model
from .core import Ollama, Settings, SolverError, Cancelled, ROOT, Question


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Beyim Solver — Groq / Ollama")
        self.geometry("960x820")
        self.minsize(800, 640)
        self.configure(background="#f4f6f8")
        self.events, self.commands = queue.Queue(), queue.Queue()
        self.stop, self.shutdown = threading.Event(), threading.Event()
        self.busy = False
        self.started_at = 0.0
        self.phase = ""
        (ROOT / ".state").mkdir(exist_ok=True)
        self.diagnostics = logging.getLogger("beyim_solver.gui")
        self.diagnostics.setLevel(logging.INFO)
        if not self.diagnostics.handlers:
            handler = RotatingFileHandler(ROOT / ".state" / "diagnostic.log", maxBytes=500_000,
                                          backupCount=1, encoding="utf-8")
            handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
            self.diagnostics.addHandler(handler)
        try:
            self.settings = Settings.load()
        except SolverError as exc:
            messagebox.showerror("Настройки", str(exc), parent=self)
            self.settings = Settings()
        self.build()
        threading.Thread(target=self.worker, daemon=True).start()
        self.after(100, self.poll)
        self.protocol("WM_DELETE_WINDOW", self.close)

    def build(self):
        style = ttk.Style(self)
        style.theme_use("clam")
        style.configure(".", font=("Segoe UI", 11))
        style.configure("TFrame", background="#f4f6f8")
        style.configure("TLabel", background="#f4f6f8", foreground="#202b36")
        style.configure("TButton", padding=(12, 10))
        style.configure("Title.TLabel", font=("Segoe UI Semibold", 23))
        style.configure("Primary.TButton", background="#145d77", foreground="white")
        style.map("Primary.TButton", background=[("active", "#10485d"), ("disabled", "#657681")])
        style.configure("Stop.TButton", foreground="#9c2525")
        frame = ttk.Frame(self, padding=24)
        frame.pack(fill="both", expand=True)
        ttk.Label(frame, text="Beyim Solver", style="Title.TLabel").pack(anchor="w")
        ttk.Label(frame, text="Groq — облачное решение · Ollama — локальный режим").pack(anchor="w", pady=(4, 20))
        notebook = ttk.Notebook(frame)
        notebook.pack(fill="x")
        general = ttk.Frame(notebook, padding=16)
        advanced = ttk.Frame(notebook, padding=16)
        local = ttk.Frame(notebook, padding=16)
        notebook.add(general, text=" Подключение ")
        notebook.add(local, text=" Локальная Ollama ")
        notebook.add(advanced, text=" Распознавание страницы ")
        self.fields = {}
        rows = [("url", "Адрес учебного кабинета"), ("provider", "Сервис ИИ"),
                ("groq_model", "Модель Groq"), ("max_questions", "Лимит заданий")]
        for i, (key, label) in enumerate(rows):
            ttk.Label(general, text=label).grid(row=i, column=0, sticky="w", padx=(0, 16), pady=5)
            var = tk.StringVar(value=str(getattr(self.settings, key)))
            self.fields[key] = var
            if key == "provider":
                entry = ttk.Combobox(general, textvariable=var, values=("groq", "ollama"), state="readonly")
            elif key == "groq_model":
                entry = self.groq_box = ttk.Combobox(general, textvariable=var)
            else:
                entry = ttk.Entry(general, textvariable=var)
            entry.grid(row=i, column=1, sticky="ew", pady=5)
        self.api_key = tk.StringVar()
        ttk.Label(general, text="API-ключ Groq").grid(row=4, column=0, sticky="w")
        ttk.Entry(general, textvariable=self.api_key, show="*").grid(row=4, column=1, sticky="ew", pady=5)
        ttk.Label(general, text="Ключ хранится только до закрытия программы. Можно задать GROQ_API_KEY.",
                  wraplength=740).grid(row=5, column=0, columnspan=2, sticky="w")
        ttk.Label(general, text="В режиме Groq вопрос и снимок задания отправляются в облако Groq.",
                  wraplength=740).grid(row=6, column=0, columnspan=2, sticky="w", pady=(6, 0))
        general.columnconfigure(1, weight=1)
        for i, (key, label) in enumerate([("ollama_url", "Сервер Ollama"),
                                        ("model", "Модель для текста"), ("vision_model", "Модель для рисунков")]):
            ttk.Label(local, text=label).grid(row=i, column=0, sticky="w", padx=(0, 16), pady=5)
            var = tk.StringVar(value=str(getattr(self.settings, key)))
            self.fields[key] = var
            entry = ttk.Combobox(local, textvariable=var) if key != "ollama_url" else ttk.Entry(local, textvariable=var)
            entry.grid(row=i, column=1, sticky="ew", pady=5)
            if key == "model": self.model_box = entry
            if key == "vision_model": self.vision_box = entry
        local.columnconfigure(1, weight=1)
        ttk.Label(advanced, text="Пустые поля — автоматическое распознавание. CSS-селекторы сохраняются локально.",
                  wraplength=760).grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 8))
        self.selectors = {}
        names = {"root": "Блок одного задания", "question": "Текст вопроса (внутри блока)",
                 "options": "Варианты (внутри блока)", "input": "Поле ответа (внутри блока)",
                 "submit": "Кнопка проверки", "next": "Кнопка перехода", "complete": "Признак завершения"}
        for i, (key, label) in enumerate(names.items(), 1):
            ttk.Label(advanced, text=label).grid(row=i, column=0, sticky="w", padx=(0, 16), pady=3)
            var = tk.StringVar(value=self.settings.selectors.get(key, ""))
            self.selectors[key] = var
            ttk.Entry(advanced, textvariable=var).grid(row=i, column=1, sticky="ew", pady=3)
        advanced.columnconfigure(1, weight=1)
        toolbar = ttk.Frame(frame)
        toolbar.pack(fill="x", pady=(16, 8))
        self.buttons = []
        for label, command in [("Проверить ИИ", "check"), ("Открыть Beyim", "open"),
                               ("Прочитать вопрос", "read"), ("Только решение", "solve")]:
            button = ttk.Button(toolbar, text=label, command=lambda c=command: self.dispatch(c))
            button.pack(side="left", padx=(0, 8))
            self.buttons.append(button)
        actions = ttk.Frame(frame)
        actions.pack(fill="x", pady=(0, 12))
        for label, command, appearance in [("Автопрохождение", "auto", "Primary.TButton"),
                                            ("Отправить один ответ", "step", "TButton"),
                                            ("Тест ИИ", "test", "TButton")]:
            button = ttk.Button(actions, text=label, style=appearance, command=lambda c=command: self.dispatch(c))
            button.pack(side="left", padx=(0, 8))
            self.buttons.append(button)
        self.stop_button = ttk.Button(actions, text="Остановить", style="Stop.TButton", command=self.cancel, state="disabled")
        self.stop_button.pack(side="right")
        self.status = tk.StringVar(value="Проверьте ИИ, затем откройте Beyim и войдите в аккаунт.")
        ttk.Label(frame, textvariable=self.status, wraplength=850).pack(anchor="w", pady=(0, 8))
        self.output = scrolledtext.ScrolledText(frame, wrap="word", font=("Segoe UI", 11),
                                              background="white", foreground="#202b36", relief="flat", padx=12, pady=12,
                                              height=10, state="disabled")
        self.output.pack(fill="both", expand=True)
        ttk.Label(frame, text="Остановка доступна во время решения. Результаты модели могут содержать ошибки.").pack(anchor="w", pady=(10, 0))
        self.bind("<Escape>", lambda _: self.cancel())

    def log(self, text):
        self.events.put(("log", str(text)))
        if str(text).startswith(("Ollama решает", "Читаю изображение", "В задании есть рисунок", "Модель вернула неверный", "Освобождаю память", "Groq решает", "Лимит Groq")):
            self.events.put(("phase", str(text)))

    def read_settings(self):
        from dataclasses import replace
        try:
            new = replace(self.settings, provider=self.fields["provider"].get(),
                          groq_model=self.fields["groq_model"].get().strip(), url=self.fields["url"].get().strip(),
                          ollama_url=self.fields["ollama_url"].get().strip(), model=self.fields["model"].get().strip(),
                          vision_model=self.fields["vision_model"].get().strip(),
                          max_questions=int(self.fields["max_questions"].get()),
                          selectors={k: v.get().strip() for k, v in self.selectors.items()})
            new.validate()
            if new.provider == "ollama":
                Ollama(new)
            new.save()
            self.settings = new
            return new
        except (ValueError, SolverError, OSError) as exc:
            raise SolverError(f"Проверьте настройки: {exc}") from exc

    def dispatch(self, command):
        if self.busy:
            return
        try:
            settings = self.read_settings()
        except SolverError as exc:
            messagebox.showerror("Настройки", str(exc), parent=self)
            return
        self.stop.clear()
        self.busy = True
        self.started_at = time.monotonic()
        self.phase = "Выполняется"
        for button in self.buttons:
            button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.status.set("Выполняется…")
        self.commands.put((command, settings, self.api_key.get().strip()))

    def cancel(self):
        if self.busy:
            self.stop.set()
            self.phase = "Останавливаю"
            self.status.set("Останавливаю. Новые действия не будут начаты…")

    def worker(self):
        browser = None
        submitted = set()
        try:
            while not self.shutdown.is_set():
                try:
                    command, settings, api_key = self.commands.get(timeout=0.1)
                except queue.Empty:
                    if browser and browser.page and not browser.page.is_closed():
                        try:
                            browser.page.wait_for_timeout(50)
                        except Exception:
                            browser.close()
                            browser = None
                    continue
                try:
                    self.diagnostics.info("Command: %s", command)
                    client = create_client(settings, self.log, api_key) if command in ("check", "solve", "auto", "step", "test") else None
                    if command == "check":
                        models = client.models(self.stop)
                        self.events.put(("models", (settings.provider, models)))
                        self.log(settings.provider + " доступен. Модели: " + (", ".join(models) or "список пуст"))
                        if selected_model(settings) not in models:
                            raise SolverError(f"Модель {selected_model(settings)} недоступна. Выберите модель из списка сервиса.")
                        if settings.provider == "ollama" and settings.vision_model and settings.vision_model not in models:
                            self.log(f"Рисунки пока недоступны. Установите: ollama pull {settings.vision_model}")
                    elif command == "test":
                        question = Question("Реши уравнение 3x + 7 = 22. Чему равен x?",
                                            [{"text": "3"}, {"text": "5"}, {"text": "7"}], "single")
                        started = time.monotonic()
                        answer = client.solve(question, self.stop)
                        if answer["answer_ids"] != [2]:
                            raise SolverError("Модель ошиблась в контрольном примере. Проверьте настройки модели.")
                        self.log(f"Тест ИИ пройден за {time.monotonic() - started:.1f} с: x = 5. Ответ в Beyim не отправлялся.")
                    else:
                        if browser and (not browser.context or not browser.context.pages):
                            browser.close()
                            browser = None
                        if not browser:
                            browser = Browser(settings, self.log)
                        browser.settings = settings
                        if command == "open":
                            browser.open()
                        else:
                            browser.choose_page()
                            if command == "read":
                                q = browser.read()
                                self.log(f"Тип: {q.kind}\nВопрос: {q.text}")
                                for i, option in enumerate(q.options, 1):
                                    self.log(f"  {i}. {option['text']}")
                                self.log("Есть изображение: " + ("да" if q.has_image else "нет"))
                            else:
                                runner = Runner(browser, client, settings, self.stop, self.log)
                                runner.submitted = submitted
                                if command == "solve":
                                    runner.solve()
                                else:
                                    runner.run(1 if command == "step" else settings.max_questions)
                    self.events.put(("done", "Готово."))
                except Cancelled as exc:
                    self.diagnostics.info("Command %s cancelled", command)
                    self.log(str(exc))
                    self.events.put(("done", "Остановлено по команде пользователя."))
                except Exception as exc:
                    self.diagnostics.exception("Command %s failed", command)
                    self.log(str(exc))
                    self.events.put(("done", "Остановлено: " + str(exc).splitlines()[0]))
        finally:
            if browser:
                browser.close()
            self.events.put(("closed", ""))

    def poll(self):
        try:
            while True:
                kind, data = self.events.get_nowait()
                if kind == "log":
                    self.output.configure(state="normal")
                    self.output.insert("end", data + "\n\n")
                    self.output.see("end")
                    self.output.configure(state="disabled")
                elif kind == "models":
                    provider, models = data
                    if provider == "groq":
                        self.groq_box.configure(values=models)
                    else:
                        self.model_box.configure(values=models)
                        self.vision_box.configure(values=models)
                elif kind == "phase":
                    self.phase = data
                elif kind == "done":
                    self.busy = False
                    self.status.set(data)
                    for button in self.buttons:
                        button.configure(state="normal")
                    self.stop_button.configure(state="disabled")
                elif kind == "closed":
                    self.destroy()
                    return
        except queue.Empty:
            pass
        if self.busy:
            elapsed = int(time.monotonic() - self.started_at)
            self.status.set(f"{self.phase} · {elapsed} с. Ожидание модели не означает зависание.")
        self.after(100, self.poll)

    def close(self):
        self.stop.set()
        self.shutdown.set()
        self.status.set("Закрываю браузер бота…")
        for button in self.buttons:
            button.configure(state="disabled")


def main():
    App().mainloop()
