from __future__ import annotations

import queue
import threading
import tkinter as tk
from tkinter import messagebox, scrolledtext, ttk

from .browser import Browser, Runner
from .core import Ollama, Settings, SolverError, ROOT


class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Beyim Solver — Ollama")
        self.geometry("960x760")
        self.minsize(800, 640)
        self.configure(background="#f4f6f8")
        self.events, self.commands = queue.Queue(), queue.Queue()
        self.stop, self.shutdown = threading.Event(), threading.Event()
        self.busy = False
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
        ttk.Label(frame, text="Локальная модель Ollama · Автоматическое прохождение заданий").pack(anchor="w", pady=(4, 20))
        notebook = ttk.Notebook(frame)
        notebook.pack(fill="x")
        general = ttk.Frame(notebook, padding=16)
        advanced = ttk.Frame(notebook, padding=16)
        notebook.add(general, text=" Подключение ")
        notebook.add(advanced, text=" Распознавание страницы ")
        self.fields = {}
        rows = [("url", "Адрес учебного кабинета"), ("ollama_url", "Сервер Ollama"),
                ("model", "Модель"), ("max_questions", "Лимит заданий")]
        for i, (key, label) in enumerate(rows):
            ttk.Label(general, text=label).grid(row=i, column=0, sticky="w", padx=(0, 16), pady=5)
            var = tk.StringVar(value=str(getattr(self.settings, key)))
            self.fields[key] = var
            if key == "model":
                entry = ttk.Combobox(general, textvariable=var)
                self.model_box = entry
            else:
                entry = ttk.Entry(general, textvariable=var)
            entry.grid(row=i, column=1, sticky="ew", pady=5)
        general.columnconfigure(1, weight=1)
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
        for label, command in [("Проверить Ollama", "check"), ("Открыть Beyim", "open"),
                               ("Прочитать вопрос", "read"), ("Только решение", "solve")]:
            button = ttk.Button(toolbar, text=label, command=lambda c=command: self.dispatch(c))
            button.pack(side="left", padx=(0, 8))
            self.buttons.append(button)
        actions = ttk.Frame(frame)
        actions.pack(fill="x", pady=(0, 12))
        for label, command, appearance in [("Автопрохождение", "auto", "Primary.TButton"),
                                            ("Отправить один ответ", "step", "TButton")]:
            button = ttk.Button(actions, text=label, style=appearance, command=lambda c=command: self.dispatch(c))
            button.pack(side="left", padx=(0, 8))
            self.buttons.append(button)
        self.stop_button = ttk.Button(actions, text="Остановить", style="Stop.TButton", command=self.cancel, state="disabled")
        self.stop_button.pack(side="right")
        self.status = tk.StringVar(value="Проверьте Ollama, затем откройте Beyim и войдите в аккаунт.")
        ttk.Label(frame, textvariable=self.status, wraplength=850).pack(anchor="w", pady=(0, 8))
        self.output = scrolledtext.ScrolledText(frame, wrap="word", font=("Segoe UI", 11),
                                              background="white", foreground="#202b36", relief="flat", padx=12, pady=12,
                                              height=10, state="disabled")
        self.output.pack(fill="both", expand=True)
        ttk.Label(frame, text="Остановка доступна во время решения. Результаты модели могут содержать ошибки.").pack(anchor="w", pady=(10, 0))
        self.bind("<Escape>", lambda _: self.cancel())

    def log(self, text):
        self.events.put(("log", str(text)))

    def read_settings(self):
        from dataclasses import replace
        try:
            new = replace(self.settings, url=self.fields["url"].get().strip(),
                          ollama_url=self.fields["ollama_url"].get().strip(), model=self.fields["model"].get().strip(),
                          max_questions=int(self.fields["max_questions"].get()),
                          selectors={k: v.get().strip() for k, v in self.selectors.items()})
            new.validate()
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
        for button in self.buttons:
            button.configure(state="disabled")
        self.stop_button.configure(state="normal")
        self.status.set("Выполняется…")
        self.commands.put((command, settings))

    def cancel(self):
        if self.busy:
            self.stop.set()
            self.status.set("Останавливаю. Новые действия не будут начаты…")

    def worker(self):
        browser = None
        submitted = set()
        try:
            while not self.shutdown.is_set():
                try:
                    command, settings = self.commands.get(timeout=0.1)
                except queue.Empty:
                    if browser and browser.page and not browser.page.is_closed():
                        try:
                            browser.page.wait_for_timeout(50)
                        except Exception:
                            browser.close()
                            browser = None
                    continue
                try:
                    client = Ollama(settings)
                    if command == "check":
                        models = client.models(self.stop)
                        self.events.put(("models", models))
                        self.log("Ollama доступна. Модели: " + (", ".join(models) or "список пуст"))
                        if settings.model not in models:
                            raise SolverError(f"Модель {settings.model} не установлена. В PowerShell: ollama pull {settings.model}")
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
                                if settings.model not in client.models(self.stop):
                                    raise SolverError(f"Модель {settings.model} не найдена в Ollama.")
                                runner = Runner(browser, client, settings, self.stop, self.log)
                                runner.submitted = submitted
                                if command == "solve":
                                    runner.solve()
                                else:
                                    runner.run(1 if command == "step" else settings.max_questions)
                    self.events.put(("done", "Готово."))
                except Exception as exc:
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
                    self.model_box.configure(values=data)
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
        self.after(100, self.poll)

    def close(self):
        self.stop.set()
        self.shutdown.set()
        self.status.set("Закрываю браузер бота…")
        for button in self.buttons:
            button.configure(state="disabled")


def main():
    App().mainloop()
