import AppKit
import Security

final class ServerApp: NSObject, NSApplicationDelegate {
    private var server: Process?
    private let service = "com.beyimsolver.local-server"
    private var project: URL {
        Bundle.main.bundleURL.deletingLastPathComponent()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {}

    func application(_ application: NSApplication, open urls: [URL]) {
        guard urls.contains(where: { $0.absoluteString == "beyim-solver://start" }) else { return }
        startServer()
    }

    private func startServer() {
        guard server?.isRunning != true else { return }
        do {
            let key = try groqKey()
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/bin/bash")
            process.arguments = [project.appendingPathComponent("Start-beta.command").path]
            process.currentDirectoryURL = project
            process.environment = ProcessInfo.processInfo.environment.merging(["GROQ_API_KEY": key]) { _, new in new }
            process.standardInput = FileHandle.nullDevice
            let log = project.appendingPathComponent(".state/safari-server.log")
            try FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
            if !FileManager.default.fileExists(atPath: log.path) {
                FileManager.default.createFile(atPath: log.path, contents: nil, attributes: [.posixPermissions: 0o600])
            }
            let output = try FileHandle(forWritingTo: log)
            try output.truncate(atOffset: 0)
            process.standardOutput = output
            process.standardError = output
            try process.run()
            server = process
        } catch KeyError.cancelled {
            return
        } catch {
            showError("Не удалось запустить сервер. Проверьте доступ к папке проекта и Связке ключей.")
        }
    }

    private enum KeyError: Error { case cancelled, unavailable }
    private func groqKey() throws -> String {
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: "Groq"
        ]
        var result: CFTypeRef?
        var query = item
        query[kSecReturnData as String] = true
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecSuccess, let data = result as? Data,
           let key = String(data: data, encoding: .utf8) { return key }
        guard status == errSecItemNotFound else { throw KeyError.unavailable }

        let alert = NSAlert()
        alert.messageText = "Ключ Groq для Beyim Solver"
        alert.informativeText = "Ключ сохранится в Связке ключей macOS."
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        alert.accessoryView = field
        alert.addButton(withTitle: "Запустить сервер")
        alert.addButton(withTitle: "Отмена")
        alert.window.initialFirstResponder = field
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { throw KeyError.cancelled }
        let key = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !key.isEmpty else { throw KeyError.cancelled }
        var entry = item
        entry[kSecValueData as String] = Data(key.utf8)
        guard SecItemAdd(entry as CFDictionary, nil) == errSecSuccess else { throw KeyError.unavailable }
        return key
    }

    private func showError(_ message: String) {
        let alert = NSAlert()
        alert.messageText = message
        NSApp.activate(ignoringOtherApps: true)
        alert.runModal()
    }
}

let app = NSApplication.shared
let delegate = ServerApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()
