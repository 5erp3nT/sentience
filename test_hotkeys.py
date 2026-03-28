import time
from pynput import keyboard

active_keys = set()

def on_press(key):
    global active_keys
    active_keys.add(key)
    # Output clearly what key was pressed
    print(f"[PRESS] {key} | Active: {active_keys}")
    
    # Test for Alt + Forward Slash
    has_alt = any(k in active_keys for k in [keyboard.Key.alt, keyboard.Key.alt_l, keyboard.Key.alt_r, keyboard.Key.alt_gr])
    has_slash = False
    try:
        if hasattr(key, 'char') and key.char == '/':
            has_slash = True
        elif str(key) == "'/'":
            has_slash = True
    except: pass

    if has_alt and has_slash:
        print("\n" + "="*40)
        print("!!! HOTKEY SUCCESS: ALT + / DETECTED !!!")
        print("="*40 + "\n")

    # Double check for Alt + S (sentience) just in case
    has_s = False
    try:
        if hasattr(key, 'char') and key.char.lower() == 's':
            has_s = True
    except: pass
    
    if has_alt and has_s:
        print("\n" + "="*40)
        print("!!! HOTKEY SUCCESS: ALT + S DETECTED !!!")
        print("="*40 + "\n")

def on_release(key):
    global active_keys
    if key in active_keys:
        active_keys.remove(key)
    print(f"[RELEASE] {key}")

def main():
    print("="*60)
    print("SENTIENCE HOTKEY DIAGNOSTIC TOOL")
    print("="*60)
    print("1. Press and hold various combinations (Alt+/, Alt+S, etc.)")
    print("2. Observe the [PRESS] outputs below.")
    print("3. Check if Linux is hearing 'Alt' and '/' at the same time.")
    print("4. Press Esc to exit.")
    print("="*60)

    with keyboard.Listener(on_press=on_press, on_release=on_release) as listener:
        listener.join()

if __name__ == "__main__":
    main()
