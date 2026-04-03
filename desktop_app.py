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
from PyQt6.QtCore import Qt, pyqtSignal, QObject, QTimer
import fcntl
from pynput import keyboard

class Communicator(QObject):
    response_received = pyqtSignal(str)
    recording_changed = pyqtSignal(bool)
    ui_ready = pyqtSignal() # New signal for thread-safe UI enablement


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
        self.whatsapp_process = None
        self.ui_process = None
        self.is_alt_pressed = False
        self.active_keys = set()
        self.communicator = Communicator()
        self.communicator.response_received.connect(self.display_modal)
        self.communicator.recording_changed.connect(self.update_tray_icon)
        self.communicator.ui_ready.connect(self.enable_ui_and_hotkeys)
        
        self.ui_enabled = False # Hotkeys and Icon hidden until server ready
        
        subprocess.run(["pkill", "-f", "sentience_server"], stderr=subprocess.DEVNULL)
        subprocess.run(["pkill", "-f", "whatsapp_connector"], stderr=subprocess.DEVNULL)
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
        
        # WhatsApp Integration Toggle
        self.wa_action = QAction("WhatsApp Integration (Beta)", self.menu)
        self.wa_action.setCheckable(True)
        try:
            settings_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")
            if os.path.exists(settings_path):
                with open(settings_path, "r") as f:
                    settings = json.load(f)
                    self.wa_action.setChecked(settings.get("whatsapp_enabled", True))
            else:
                self.wa_action.setChecked(True)
        except:
            self.wa_action.setChecked(True)
            
        self.wa_action.triggered.connect(self.toggle_whatsapp)
        self.menu.addAction(self.wa_action)
        
        # Start WhatsApp if enabled
        if self.wa_action.isChecked():
            QTimer.singleShot(2000, self.start_whatsapp) # Slight delay for server warmup
        
        quit_action = QAction("Quit", self.menu)
        quit_action.triggered.connect(self.quit_app)
        self.menu.addAction(quit_action)
        
        self.tray_icon.setContextMenu(self.menu)
        self.tray_icon.activated.connect(self.tray_activated)
        # self.tray_icon.show()  <-- HELD UNTIL READY
        
        # Start backend monitor (WebSocket)
        self.ws_thread = threading.Thread(target=self.monitor_backend, daemon=True)
        self.ws_thread.start()

    def enable_ui_and_hotkeys(self):
        """Called once the server is fully initialized."""
        if self.ui_enabled:
            return
        self.ui_enabled = True
        print("DEBUG: Enabling UI and Hotkey Listener...")
        self.tray_icon.show()
        
        # Start hotkey listener only now
        self.hotkey_thread = threading.Thread(target=self.run_hotkey_listener, daemon=True)
        self.hotkey_thread.start()

    def monitor_server_logs(self):
        """Pipes server logs to console and waits for ready signal."""
        if not self.server_process or not self.server_process.stdout:
            return
            
        import time
        # The user's specific trigger string, made more robust
        trigger_fragment = "connection open"
        
        print("DEBUG: Log monitoring thread started. Watching for 'connection open'...")
        
        for line in self.server_process.stdout:
            # Print EXACTLY what we received to debug
            sys.stdout.write(f"Server: {line}")
            sys.stdout.flush()
            
            if trigger_fragment.lower() in line.lower():
                print(f"DEBUG: Trigger MATCHED on line: {repr(line)}")
                print("DEBUG: Waiting 1 second for stabilization...")
                time.sleep(1.0)
                # Ensure we call UI updates on the main thread via Signal
                print("DEBUG: Emitting ui_ready signal now...")
                self.communicator.ui_ready.emit()
                # Keep piping logs but we don't need to check trigger anymore
                break
        
        # Continue piping logs for the rest of the session
        for line in self.server_process.stdout:
            sys.stdout.write(f"Server: {line}")
            sys.stdout.flush()

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
            print("DEBUG: Launching Sentience Server process...")
            self.server_process = subprocess.Popen(
                [python_exe, server_script],
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                bufsize=1
            )
            # Monitor logs in a separate thread
            threading.Thread(target=self.monitor_server_logs, daemon=True).start()

    def start_whatsapp(self):
        if self.whatsapp_process and self.whatsapp_process.poll() is None:
            return
            
        script_dir = os.path.dirname(os.path.abspath(__file__))
        wa_script = os.path.join(script_dir, "whatsapp_connector.js")
        if os.path.exists(wa_script):
            print("DEBUG: Starting WhatsApp Connector...")
            # Use Node to run the script. It will print QR code to terminal if needed.
            self.whatsapp_process = subprocess.Popen(["node", wa_script])

    def stop_whatsapp(self):
        if self.whatsapp_process:
            print("DEBUG: Stopping WhatsApp Connector...")
            self.whatsapp_process.terminate()
            self.whatsapp_process = None

    def toggle_whatsapp(self):
        enabled = self.wa_action.isChecked()
        if enabled:
            self.start_whatsapp()
        else:
            self.stop_whatsapp()
        
        # Persist to settings.json
        try:
            settings_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "settings.json")
            settings = {}
            if os.path.exists(settings_path):
                with open(settings_path, "r") as f:
                    settings = json.load(f)
            settings["whatsapp_enabled"] = enabled
            with open(settings_path, "w") as f:
                json.dump(settings, f, indent=4)
        except Exception as e:
            print(f"DEBUG: Failed to save WhatsApp setting: {e}")

    def run_hotkey_listener(self):
        with keyboard.Listener(on_press=self.on_press, on_release=self.on_release) as listener:
            listener.join()

    def on_press(self, key):
        if not self.ui_enabled:
            return
        
        k_str = str(key)
        self.active_keys.add(k_str)
        
        # Robust Alt detection
        has_alt = any(k in self.active_keys for k in ["Key.alt", "Key.alt_l", "Key.alt_r", "Key.alt_gr"])
        
        # Robust Backslash detection
        has_backslash = (hasattr(key, 'char') and key.char == '\\') or k_str == r"'\\'" or k_str == "Key.backslash"
        if not has_backslash:
            # Check existing keys in case this is a repeat event
            has_backslash = r"'\\'" in self.active_keys or "Key.backslash" in self.active_keys

        if has_alt and has_backslash:
            if not self.is_alt_pressed:
                self.is_alt_pressed = True
                print("DEBUG: Hotkey Combo Triggered (START)")
                self.communicator.recording_changed.emit(True)
                threading.Thread(target=self.trigger_backend, args=("start",)).start()

    def on_release(self, key):
        k_str = str(key)
        # Remove with extra safety for Linux repeat events/modifiers
        if k_str in self.active_keys:
            self.active_keys.remove(k_str)
        if key in self.active_keys:
            self.active_keys.remove(key)
            
        # If we were recording, check if the combo is broken
        if self.is_alt_pressed:
            has_alt = any(k in self.active_keys for k in ["Key.alt", "Key.alt_l", "Key.alt_r", "Key.alt_gr"])
            has_backslash = r"'\\'" in self.active_keys or "Key.backslash" in self.active_keys
            
            # Additional check: if the key just released IS one of our triggers, stop recording
            # This handles cases where pynput state might be out of sync
            is_trigger_release = k_str in ["Key.alt", "Key.alt_l", "Key.alt_r", "Key.alt_gr", r"'\\'", "Key.backslash"]
            if hasattr(key, 'char') and key.char == '\\':
                is_trigger_release = True

            if not (has_alt and has_backslash) or is_trigger_release:
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
                # Register with the same session as the Chat UI so we receive its responses
                ws.send(json.dumps({
                    "type": "session.update",
                    "session": {
                        "session_id": "default_user",
                        "client_type": "modal"
                    }
                }))
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
        if self.whatsapp_process:
            self.whatsapp_process.terminate()
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
            self.ui_process = subprocess.Popen(["google-chrome", f"--app={url}", "--window-size=1240,1280"])
        except:
            try:
                self.ui_process = subprocess.Popen(["chromium-browser", f"--app={url}", "--window-size=1240,1280"])
            except:
                import webbrowser
                webbrowser.open(url)

    def quit_app(self):
        if self.server_process: self.server_process.terminate()
        if self.whatsapp_process: self.whatsapp_process.terminate()
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
