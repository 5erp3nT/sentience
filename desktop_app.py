import sys
import os
import subprocess
import webbrowser
import requests
import threading
import json
import websocket # pip install websocket-client
from PyQt6.QtWidgets import QApplication, QSystemTrayIcon, QMenu, QWidget, QVBoxLayout, QTextEdit
from PyQt6.QtGui import QIcon, QAction, QPixmap, QColor, QFont, QPainter, QBrush
from PyQt6.QtCore import Qt, pyqtSignal, QObject
import fcntl
from pynput import keyboard

class Communicator(QObject):
    response_received = pyqtSignal(str)
    recording_changed = pyqtSignal(bool)

class ResponseModal(QWidget):
    def __init__(self):
        super().__init__()
        self.setWindowFlags(Qt.WindowType.WindowStaysOnTopHint | Qt.WindowType.FramelessWindowHint | Qt.WindowType.Tool)
        self.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground)
        
        self.layout = QVBoxLayout()
        self.text_area = QTextEdit()
        self.text_area.setReadOnly(True)
        self.text_area.setStyleSheet("""
            QTextEdit {
                background-color: rgba(30, 30, 40, 240);
                color: #ffffff;
                border: 2px solid #00f0ff;
                border-radius: 12px;
                padding: 15px;
                font-size: 15px;
            }
        """)
        self.text_area.setFont(QFont("Inter", 12))
        self.layout.addWidget(self.text_area)
        self.setLayout(self.layout)
        self.resize(500, 300)
        
        screen = QApplication.primaryScreen().geometry()
        self.move((screen.width() - self.width()) // 2, 80)
        self.hide()

    def show_response(self, text):
        self.text_area.setMarkdown(text)
        self.show()
        self.raise_()
        self.activateWindow()
        # Auto-hide after 15 seconds
        from PyQt6.QtCore import QTimer
        QTimer.singleShot(15000, self.hide)

class StatusbarAssistant:
    def __init__(self, app):
        self.app = app
        self.server_process = None
        self.ui_process = None
        self.is_alt_pressed = False
        self.active_keys = set()
        self.communicator = Communicator()
        self.communicator.response_received.connect(self.display_modal)
        self.communicator.recording_changed.connect(self.update_tray_icon)
        
        subprocess.run(["pkill", "-f", "sentience_server"], stderr=subprocess.DEVNULL)
        import time
        time.sleep(1.0)
        
        self.start_backend()
        self.modal = ResponseModal()

        self.tray_icon = QSystemTrayIcon()
        
        # Detect actual brain png (renamed to bust linux icon cache)
        icon_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "sentience_brain.png")
        if os.path.exists(icon_path):
            self.icon_green = QIcon(icon_path)
            self.app.setWindowIcon(self.icon_green)
        else:
            self.icon_green = self.create_solid_icon("#00ff66")
            
        self.icon_red = self.create_circle_icon("#ff3333")
        
        self.tray_icon.setIcon(self.icon_green)
        self.tray_icon.setToolTip("Sentience Assistant")
        
        # Restore Context Menu
        self.menu = QMenu()
        show_action = QAction("Open UI", self.menu)
        show_action.triggered.connect(self.toggle_window)
        self.menu.addAction(show_action)
        
        # Toggle TTS
        self.tts_action = QAction("Enable Text-to-Speech", self.menu)
        self.tts_action.setCheckable(True)
        try:
            settings_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")
            with open(settings_path, "r") as f:
                settings = json.load(f)
                self.tts_action.setChecked(settings.get("tts_enabled", True))
        except:
            self.tts_action.setChecked(True)
            
        self.tts_action.triggered.connect(self.toggle_tts)
        self.menu.addAction(self.tts_action)
        
        # Restart Agent
        restart_action = QAction("Restart Agent", self.menu)
        restart_action.triggered.connect(self.restart_agent)
        self.menu.addAction(restart_action)
        
        quit_action = QAction("Quit", self.menu)
        quit_action.triggered.connect(self.quit_app)
        self.menu.addAction(quit_action)
        
        self.tray_icon.setContextMenu(self.menu)
        self.tray_icon.activated.connect(self.tray_activated)
        self.tray_icon.show()
        
        # Start hotkey listener
        self.hotkey_thread = threading.Thread(target=self.run_hotkey_listener, daemon=True)
        self.hotkey_thread.start()
        
        # Start backend monitor (WebSocket)
        self.ws_thread = threading.Thread(target=self.monitor_backend, daemon=True)
        self.ws_thread.start()

    def create_solid_icon(self, hex_color):
        pixmap = QPixmap(32, 32)
        pixmap.fill(QColor(hex_color))
        temp_path = f"/tmp/sentience_solid_{hex_color.replace('#', '')}.png"
        pixmap.save(temp_path)
        return QIcon(temp_path)

    def create_circle_icon(self, hex_color):
        pixmap = QPixmap(32, 32)
        pixmap.fill(Qt.GlobalColor.transparent)
        painter = QPainter(pixmap)
        painter.setRenderHint(QPainter.RenderHint.Antialiasing)
        painter.setBrush(QBrush(QColor(hex_color)))
        painter.setPen(Qt.PenStyle.NoPen)
        painter.drawEllipse(2, 2, 28, 28)
        painter.end()
        temp_path = f"/tmp/sentience_circle_{hex_color.replace('#', '')}.png"
        pixmap.save(temp_path)
        return QIcon(temp_path)

    def start_backend(self):
        script_dir = os.path.dirname(os.path.abspath(__file__))
        python_exe = os.path.join(script_dir, ".venv", "bin", "python3")
        server_script = os.path.join(script_dir, "sentience_server.py")
        if os.path.exists(python_exe) and os.path.exists(server_script):
            self.server_process = subprocess.Popen([python_exe, server_script])

    def run_hotkey_listener(self):
        with keyboard.Listener(on_press=self.on_press, on_release=self.on_release) as listener:
            listener.join()

    def on_press(self, key):
        self.active_keys.add(key)
        
        # Check for Alt + \
        has_alt = any(k in self.active_keys for k in [keyboard.Key.alt, keyboard.Key.alt_l, keyboard.Key.alt_r, keyboard.Key.alt_gr])
        has_backslash = False
        try:
            k_str = str(key)
            if (hasattr(key, 'char') and key.char == '\\') or k_str == r"'\\'" or k_str == r"'\''":
                has_backslash = True
        except: pass

        if has_alt and has_backslash:
            if not self.is_alt_pressed:
                self.is_alt_pressed = True
                print("DEBUG: Hotkey Combo Triggered (START)")
                self.communicator.recording_changed.emit(True)
                threading.Thread(target=self.trigger_backend, args=("start",)).start()

    def on_release(self, key):
        if key in self.active_keys:
            self.active_keys.remove(key)
            
        # If we were recording, and the combo is broken, stop
        if self.is_alt_pressed:
            has_alt = any(k in self.active_keys for k in [keyboard.Key.alt, keyboard.Key.alt_l, keyboard.Key.alt_r, keyboard.Key.alt_gr])
            has_backslash = any((hasattr(k, 'char') and k.char == '\\') or (str(k) == r"'\\'") for k in self.active_keys)
            
            if not (has_alt and has_backslash):
                self.is_alt_pressed = False
                print("DEBUG: Hotkey Combo Released (STOP)")
                self.communicator.recording_changed.emit(False)
                threading.Thread(target=self.trigger_backend, args=("stop",)).start()

    def update_tray_icon(self, is_recording):
        print(f"DEBUG: UI Thread updating icon to {'RED' if is_recording else 'GREEN'}")
        if is_recording:
            self.tray_icon.setIcon(self.icon_red)
        else:
            self.tray_icon.setIcon(self.icon_green)

    def trigger_backend(self, action):
        if action == "start":
            # Check if any UI is connected to hear the mic
            try:
                resp = requests.get("http://localhost:8345/status/ui", timeout=1.0)
                if resp.status_code == 200:
                    data = resp.json()
                    if data.get("active_voice_clients", 0) == 0:
                        print("DEBUG: No Voice-capable UI connected. Waking app for recording...")
                        self.toggle_window()
                        # Wait a moment for Chrome to connect its websocket
                        import time
                        time.sleep(2.0)
            except:
                pass

        try:
            requests.post(f"http://localhost:8345/trigger/{action}", timeout=2.0)
        except: pass

    def monitor_backend(self):
        """Monitor the backend via WebSocket to show modals for responses."""
        import json
        import time
        import websocket
        while True:
            try:
                ws = websocket.create_connection("ws://localhost:8345/v1/realtime")
                while True:
                    result = ws.recv()
                    msg = json.loads(result)
                    if msg.get("type") == "response.ai_text.done":
                        self.communicator.response_received.emit(msg.get("text", ""))
            except:
                time.sleep(2.0) # Retry if server not up yet

    def is_chat_window_focused(self):
        try:
            out = subprocess.check_output(["xprop", "-root", "_NET_ACTIVE_WINDOW"], timeout=1).decode()
            if "window id #" in out:
                win_id = out.split("window id #")[1].split(",")[0].strip()
                if win_id and win_id != "0x0":
                    win_info = subprocess.check_output(["xprop", "-id", win_id, "WM_NAME"], timeout=1).decode()
                    if "Sentience" in win_info or "8345" in win_info:
                        return True
        except:
            pass
        return False

    def display_modal(self, text):
        if not self.is_chat_window_focused():
            self.modal.show_response(text)
        else:
            print("DEBUG: Chat window is active. Suppressing modal popup.")

    def toggle_tts(self):
        try:
            resp = requests.post("http://localhost:8345/v1/toggle_tts", timeout=2.0)
            if resp.status_code == 200:
                is_enabled = resp.json().get("tts_enabled", True)
                self.tts_action.setChecked(is_enabled)
                print(f"DEBUG: TTS Enabled: {is_enabled}")
        except Exception as e:
            print(f"DEBUG: Failed to toggle TTS: {e}")

    def restart_agent(self):
        print("DEBUG: Restarting Sentience Agent...")
        if self.server_process:
            self.server_process.terminate()
        # Soft-quit the PyQt app so the parent start.sh loop can continue, or simply os.execl
        import sys
        import os
        os.execl(sys.executable, sys.executable, *sys.argv)

    def tray_activated(self, reason):
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.toggle_window()

    def toggle_window(self):
        # Prevent spawning duplicated active UI windows which causes overlapping audio
        if hasattr(self, 'ui_process') and self.ui_process and self.ui_process.poll() is None:
            print("DEBUG: Chat UI is already running, tracking process block.")
            # If it's already running, we might want to bring it to front/focus
            # On Linux, we can try using wmctrl if available
            try:
                subprocess.run(["wmctrl", "-a", "Sentience"], stderr=subprocess.DEVNULL)
            except: pass
            return
            
        url = "http://localhost:8345"
        try:
            # Try spawning as a native Chrome App window 
            self.ui_process = subprocess.Popen(["google-chrome", f"--app={url}", "--window-size=400,600"])
        except:
            try:
                self.ui_process = subprocess.Popen(["chromium-browser", f"--app={url}", "--window-size=400,600"])
            except:
                import webbrowser
                webbrowser.open(url)

    def quit_app(self):
        if self.server_process: self.server_process.terminate()
        self.app.quit()
        self.app.quit()

if __name__ == "__main__":
    # Singleton check using file lock
    lock_file = "/tmp/sentience_desktop.lock"
    fp = open(lock_file, "w")
    try:
        fcntl.lockf(fp, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except IOError:
        print("Sentience Assistant is already running. Focusing existing window...")
        # Try to focus the existing window via wmctrl before exiting
        subprocess.run(["wmctrl", "-a", "Sentience"], stderr=subprocess.DEVNULL)
        sys.exit(1)

    app = QApplication(sys.argv)
    app.setQuitOnLastWindowClosed(False)
    assistant = StatusbarAssistant(app)
    sys.exit(app.exec())
