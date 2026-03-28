import os
import asyncio
import json
import base64
import wave
import tempfile
import time
from fastapi import FastAPI, WebSocket
from fastapi.responses import HTMLResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
import httpx
from datetime import datetime
from openai import AsyncOpenAI
from memory_manager import MemoryManager
from faster_whisper import WhisperModel
from ddgs import DDGS

# Global STT model - initialized once to keep it in VRAM
# This may take 30-60s on first run to download the model (~3GB)
print("Loading STT model (Distil-Whisper Large-V3)...")
# Distil-Whisper fits easily in 8GB VRAM and is extremely fast
stt_model = WhisperModel("distil-large-v3", device="cuda", compute_type="float16")
print("STT model loaded and ready on GPU.")

print("Loading TTS model (Kokoro v0.19)...")
try:
    from kokoro import KPipeline
    import soundfile as sf
    import io
    import re
    tts_model = KPipeline(lang_code='a') # American English
    print("TTS model loaded successfully.")
except Exception as e:
    print(f"Warning: Failed to load TTS model: {e}")
    tts_model = None
    

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Configuration
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SETTINGS_FILE = "settings.json"
SKILLS_DIR = "skills"
SETTINGS_FILE = "settings.json"
SKILLS_DIR = "skills"

memory = MemoryManager()
inference_lock = asyncio.Lock()
active_websockets = set() # Track for broadcasting triggers
voice_clients = set() # Track specifically for mic-capable tabs
primary_voice_client = None # The one that responds to hotkeys
whatsapp_contacts = {} # Shared state: JID -> {'name': str, 'last_seen': str}
socket_to_session = {} # WS -> session_id mapping for targeted routing

async def broadcast_to_uis(message, target_ws=None, session_id=None):
    """Send a message to UI clients.
    - target_ws: send ONLY to this specific websocket.
    - session_id: send to ALL websockets registered to this session.
    - neither: broadcast to ALL connected websockets.
    """
    if target_ws:
        try:
            await target_ws.send_json(message)
            return
        except Exception:
            active_websockets.discard(target_ws)
            voice_clients.discard(target_ws)
            socket_to_session.pop(target_ws, None)
        return

    targets = active_websockets.copy()
    if session_id:
        targets = {ws for ws, sid in socket_to_session.items() if sid == session_id}

    for ws in targets:
        try:
            await ws.send_json(message)
        except Exception:
            active_websockets.discard(ws)
            voice_clients.discard(ws)
            socket_to_session.pop(ws, None)

def get_available_skills():
    """Scan skills directory for SKILL.md files and extract frontmatter."""
    skills = []
    if not os.path.exists(SKILLS_DIR):
        return []
    for skill_name in os.listdir(SKILLS_DIR):
        skill_path = os.path.join(SKILLS_DIR, skill_name, "SKILL.md")
        if os.path.exists(skill_path):
            with open(skill_path, "r") as f:
                content = f.read()
                # Simple extraction of YAML-like frontmatter
                if content.startswith("---"):
                    try:
                        parts = content.split("---", 2)
                        yaml_text = parts[1]
                        import yaml # we might need to install this or use simple regex
                        # Fallback to simple regex if yaml is not installed
                        import re
                        name_match = re.search(r"name:\s*(.*)", yaml_text)
                        desc_match = re.search(r"description:\s*[\"']?(.*?)[\"']?\s*($|\n)", yaml_text)
                        name = name_match.group(1).strip() if name_match else skill_name
                        desc = desc_match.group(1).strip() if desc_match else "No description"
                        skills.append({"id": skill_name, "name": name, "description": desc})
                    except:
                        pass
    return skills

def get_skill_full_content(skill_id):
    """Read the full body of a skill's SKILL.md."""
    skill_path = os.path.join(SKILLS_DIR, skill_id, "SKILL.md")
    if os.path.exists(skill_path):
        with open(skill_path, "r") as f:
            return f.read()
    return "Skill not found."

def load_settings():
    if os.path.exists(SETTINGS_FILE):
        with open(SETTINGS_FILE, "r") as f:
            return json.load(f)
    # Defaults
    return {
        "api_key": "",
        "model": "mistralai/mistral-7b-instruct:free",
        "multimodal_model": "google/gemini-1.5-flash",
        "heavy_thinker_model": "google/gemini-pro-1.5",
        "assistant_name": "Antigravity",
        "system_prompt": "You are a helpful and concise AI assistant living in the user's Linux status bar."
    }

def save_settings(settings):
    with open(SETTINGS_FILE, "w") as f:
        json.dump(settings, f)


class SettingsUpdate(BaseModel):
    api_key: str
    model: str
    multimodal_model: str = "google/gemini-1.5-flash"
    heavy_thinker_model: str = "google/gemini-pro-1.5"
    assistant_name: str
    system_prompt: str


@app.get("/v1/settings")
def get_settings():
    settings = load_settings()
    # Mask api key slightly for security in UI if needed, but since it's local it's fine
    return settings


@app.post("/v1/settings")
def update_settings(update: SettingsUpdate):
    settings = load_settings()
    settings["api_key"] = update.api_key
    settings["model"] = update.model
    settings["multimodal_model"] = update.multimodal_model
    settings["heavy_thinker_model"] = update.heavy_thinker_model
    settings["assistant_name"] = update.assistant_name
    settings["system_prompt"] = update.system_prompt
    save_settings(settings)
    return {"status": "ok"}

@app.post("/v1/toggle_tts")
def toggle_tts():
    settings = load_settings()
    current = settings.get("tts_enabled", True)
    settings["tts_enabled"] = not current
    save_settings(settings)
    return {"tts_enabled": settings["tts_enabled"]}


@app.get("/v1/models")
async def get_models():
    settings = load_settings()
    api_key = settings.get("api_key", "")
    headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    async with httpx.AsyncClient() as client:
        try:
            resp = await client.get("https://openrouter.ai/api/v1/models", headers=headers, timeout=15.0)
            data = resp.json()
            # Only return models that support tool calling
            if data and data.get("data"):
                data["data"] = [
                    m for m in data["data"]
                    if "tools" in m.get("supported_parameters", [])
                ]
            return data
        except:
            return {"data": []}

@app.get("/status/ui")
async def get_ui_status():
    return {
        "active_clients": len(active_websockets),
        "active_voice_clients": len(voice_clients)
    }

global_recording_state = False

@app.post("/trigger/start")
async def trigger_start():
    global global_recording_state
    global_recording_state = True
    if primary_voice_client:
        await broadcast_to_uis({"type": "control.recording.start"}, target_ws=primary_voice_client)
    else:
        # Fallback to broadcast if no primary identified yet (unlikely)
        await broadcast_to_uis({"type": "control.recording.start"})
    return {"status": "ok"}

@app.post("/trigger/stop")
async def trigger_stop():
    global global_recording_state
    global_recording_state = False
    if primary_voice_client:
        await broadcast_to_uis({"type": "control.recording.stop"}, target_ws=primary_voice_client)
    else:
        await broadcast_to_uis({"type": "control.recording.stop"})
    return {"status": "ok"}

@app.post("/v1/whatsapp/contacts")
async def update_whatsapp_contacts(contacts: dict):
    global whatsapp_contacts
    whatsapp_contacts.update(contacts)
    return {"status": "ok"}

@app.post("/v1/whatsapp/log")
async def log_whatsapp_message(data: dict):
    jid = data.get("jid")
    name = data.get("name")
    text = data.get("text")
    if jid and text:
        # Record into memory quietly without triggering a turn
        # We include the name for better searchability later
        memory.add_message(jid, "user", f"(Message from {name}): {text}")
        print(f"DEBUG: Passive Awareness - Logged WhatsApp from {name}")
    return {"status": "ok"}

@app.get("/favicon.ico", include_in_schema=False)
async def favicon():
    return HTMLResponse("")

# StaticFiles mount removed from here to prevent greedy catching of websocket paths

@app.websocket("/v1/realtime")
async def websocket_endpoint(websocket: WebSocket):
    global primary_voice_client
    await websocket.accept()
    active_websockets.add(websocket)
    print("Client connected")
    
    audio_buffer = bytearray()
    last_inference_time = time.time()
    last_transcript = ""
    session_id = "default_user"  # Persistent session across all UI reloads

    try:
        while True:
            data = await websocket.receive_text()
            message = json.loads(data)
            
            if message['type'] == 'session.update':
                # Allow client to specify a unique session_id (e.g. WhatsApp JID)
                if message.get('session', {}).get('session_id'):
                    session_id = message['session']['session_id']
                    print(f"DEBUG: Session initialized for user: {session_id}")
                
                # Register this websocket's session for targeted routing
                socket_to_session[websocket] = session_id
                
                if message.get('session', {}).get('client_type') == 'voice':
                    voice_clients.add(websocket)
                    primary_voice_client = websocket
                    print("DEBUG: Primary Voice client connected.")
                
                status_msg = {"type": "session.created", "status": "Ready"}
                await websocket.send_json(status_msg)
                
                # Send persistent chat history to UI
                history = memory.get_recent_messages(session_id, limit=20)
                await websocket.send_json({
                    "type": "response.history",
                    "messages": history
                })
                
                # If UI opened while hotkey is held down, tell it to immediately record!
                if global_recording_state:
                    await websocket.send_json({"type": "control.recording.start"})
                
            elif message['type'] == 'ui.recording.active':
                # The frontend confirmed it is successfully streaming the mic
                await broadcast_to_uis({"type": "client.recording.started"})
                
            elif message['type'] == 'input_audio_buffer.append':
                audio_bytes = base64.b64decode(message['audio'])
                audio_buffer.extend(audio_bytes)
                if len(audio_buffer) % 32000 < 2000: # Log every ~1 second of audio
                    print(f"DEBUG: Received audio packet, current buffer size: {len(audio_buffer)}")
                
                # Run inference purely for UI interim feedback
                if len(audio_buffer) > 48000 and (time.time() - last_inference_time) > 1.5:
                    last_inference_time = time.time()
                    # Run in background to avoid blocking the websocket loop
                    asyncio.create_task(self_inference_task(websocket, audio_buffer[:]))

            elif message['type'] == 'input_audio_buffer.commit':
                print(f"DEBUG: Audio buffer committed, total size: {len(audio_buffer)}")
                # Final transcription inference
                transcript = await run_inference(audio_buffer)
                await websocket.send_json({
                    "type": "response.audio_transcript.done",
                    "text": transcript
                })
                audio_buffer = bytearray()
                last_transcript = ""
                
                # Now pass it to the LLM agent
                if transcript.strip():
                    await process_llm_response(websocket, session_id, transcript)

            elif message['type'] == 'input_text':
                text_input = message.get('text', '')
                images_input = message.get('images', [])
                print(f"DEBUG: Received text input: '{text_input}' with {len(images_input)} images")
                if text_input.strip() or images_input:
                    # Echo the text just in case UI didn't naturally log it, but UI should.
                    await process_llm_response(websocket, session_id, text_input, images_input)

    except Exception:
        # Prune common disconnects silently
        pass
    finally:
        active_websockets.discard(websocket)
        voice_clients.discard(websocket)
        socket_to_session.pop(websocket, None)
        if primary_voice_client == websocket:
            primary_voice_client = next(iter(voice_clients)) if voice_clients else None
            print(f"DEBUG: Primary client disconnected. New primary: {primary_voice_client}")

async def self_inference_task(websocket, buffer_snapshot):
    """Helper task to run interim inference without blocking websocket recv."""
    transcript = await run_inference(buffer_snapshot)
    if transcript.strip():
        try:
            await websocket.send_json({
                "type": "response.audio_transcript.delta",
                "delta": transcript  # For simple UI, we just send the whole thing as delta for now
            })
        except:
            pass

# --- Tool Definitions ---
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "Get real-time weather information for a specific location (city/state or zip code).",
            "parameters": {
                "type": "object",
                "properties": {
                    "location": {
                        "type": "string",
                        "description": "The city, state, or zip code (e.g., 'Holly Springs, NC')"
                    }
                },
                "required": ["location"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web for news, facts, or products. Use 'get_weather' instead for weather queries.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "The search query"
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Execute a Linux shell command on the user's system. Use for system info, file operations, package management queries, etc. Be cautious with destructive commands.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "The bash command to execute"
                    }
                },
                "required": ["command"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "get_skill_info",
            "description": "Get detailed instructions and examples for a specific skill. Use this when you need guidance on how to perform a complex task described in the skill list.",
            "parameters": {
                "type": "object",
                "properties": {
                    "skill_id": {
                        "type": "string",
                        "description": "The ID of the skill to read (e.g., 'system_info')"
                    }
                },
                "required": ["skill_id"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "record_memory",
            "description": "Store a permanent fact or preference in MEMORY.md. This is for cross-session knowledge.",
            "parameters": {
                "type": "object",
                "properties": {
                    "fact": {
                        "type": "string",
                        "description": "The fact to remember."
                    }
                },
                "required": ["fact"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "search_memory",
            "description": "Search past conversations and facts stored in the semantic database.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query."
                    }
                },
                "required": ["query"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "send_whatsapp_message",
            "description": "Send a WhatsApp message to a specific contact or number.",
            "parameters": {
                "type": "object",
                "properties": {
                    "to": {
                        "type": "string",
                        "description": "The contact NAME (e.g. 'Ryan'), WhatsApp JID (e.g. '12345@s.whatsapp.net'), OR a phone number."
                    },
                    "message": {
                        "type": "string",
                        "description": "The text message to send."
                    }
                },
                "required": ["to", "message"]
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "list_whatsapp_contacts",
            "description": "List recently seen WhatsApp contacts and their IDs/JIDs. Use this if you need to find someone's ID to message them.",
            "parameters": {
                "type": "object",
                "properties": {}
            }
        }
    },
    {
        "type": "function",
        "function": {
            "name": "switch_to_heavy_thinker",
            "description": "Switch to the user's configured Heavy Thinker model for the rest of this response. Call this ONLY when the question requires deep multi-step reasoning, complex math, nuanced analysis, or careful long-form thinking that the main model might struggle with. Do NOT call this for simple factual questions.",
            "parameters": {
                "type": "object",
                "properties": {
                    "reason": {
                        "type": "string",
                        "description": "Brief reason why the heavy thinker is needed."
                    }
                },
                "required": ["reason"]
            }
        }
    }
]

async def execute_tool(name: str, arguments: dict) -> str:
    """Execute a tool and return the result as a string."""
    print(f"DEBUG: Executing tool {name} with args {arguments}")
    if name == "get_weather":
        location = arguments.get("location", "")
        res = await do_get_weather(location)
        print(f"DEBUG: get_weather result: {res}")
        return res
    elif name == "web_search":
        query = arguments.get("query", "")
        res = await do_web_search(query)
        print(f"DEBUG: web_search result length: {len(res)}")
        return res
    elif name == "run_command":
        command = arguments.get("command", "")
        res = await do_run_command(command)
        print(f"DEBUG: run_command result length: {len(res)}")
        return res
    elif name == "get_skill_info":
        skill_id = arguments.get("skill_id", "")
        res = get_skill_full_content(skill_id)
        return res
    elif name == "record_memory":
        fact = arguments.get("fact", "")
        return memory.update_durable_memory(fact)
    elif name == "search_memory":
        query = arguments.get("query", "")
        results = memory.search_memory(query)
        return json.dumps({"results": results})
    elif name == "send_whatsapp_message":
        to = arguments.get("to", "")
        msg = arguments.get("message", "")
        # Broadcast to all UIs/Connectors. The WhatsApp connector remains listening.
        asyncio.create_task(broadcast_to_uis({
            "type": "whatsapp.send_message",
            "jid": to,
            "text": msg
        }))
        return f"Message sent to {to}."
    elif name == "list_whatsapp_contacts":
        return json.dumps(whatsapp_contacts) if whatsapp_contacts else "No WhatsApp contacts seen yet."
    elif name == "switch_to_heavy_thinker":
        reason = arguments.get("reason", "complex reasoning required")
        return f"__SWITCH_HEAVY_THINKER__: {reason}"
    return f"Unknown tool: {name}"

async def do_get_weather(location: str) -> str:
    """Get weather data from wttr.in with better fallbacks."""
    try:
        # Strip commas as wttr.in prefers clean city+state format or zip
        clean_loc = location.replace(",", "").strip()
        # If it looks like US state format but no zip, try to extract first 2 words
        async with httpx.AsyncClient() as client:
            # Force US Imperial units (?u) for user in NC, and use a richer format
            url = f"https://wttr.in/{clean_loc.replace(' ', '+')}?u&format=%l:+%C+%t+(Feels+%f)+Wind:%w+Moon:%m+Humidity:%h"
            resp = await client.get(url, timeout=10.0)
            if resp.status_code == 200 and "Unknown" not in resp.text:
                return json.dumps({"status": "success", "result": resp.text.strip(), "source": "wttr.in"})
            
            # If failed, try ONLY the Zip if present
            import re
            zip_match = re.search(r'\b\d{5}\b', clean_loc)
            if zip_match:
                url = f"https://wttr.in/{zip_match.group(0)}?u&format=%l:+%C+%t+(Feels+%f)+Wind:%w+Moon:%m+Humidity:%h"
                resp = await client.get(url, timeout=8.0)
                if resp.status_code == 200:
                    return json.dumps({"status": "success", "result": resp.text.strip(), "source": "wttr.in/zip"})
            
            return json.dumps({"status": "error", "message": f"Service status {resp.status_code}"})
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})

async def do_web_search(query: str) -> str:
    """Perform a web search using DuckDuckGo (CAPTCHA-FREE)."""
    try:
        results = []
        # Fast instantiation directly without context manager since it's deprecated in ddgs 9.0+
        d = DDGS()
        for r in d.text(query, max_results=5):
            results.append(f"Title: {r['title']}\nSnippet: {r['body']}\nSource: {r['href']}\n")
        
        if results:
            return json.dumps({"status": "success", "results": results})
        return json.dumps({"status": "no_results", "query": query, "message": "No search results found locally."})
    except Exception as e:
        return json.dumps({"status": "error", "message": str(e)})

async def do_run_command(command: str) -> str:
    """Execute a shell command and return output."""
    # Safety: block obviously destructive commands
    dangerous = ["rm -rf /", "mkfs", "dd if=", ":(){", "fork bomb"]
    for d in dangerous:
        if d in command:
            return f"Blocked: '{command}' looks dangerous."
    try:
        process = await asyncio.create_subprocess_shell(
            command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE
        )
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=15)
        output = stdout.decode().strip()
        err = stderr.decode().strip()
        result = output if output else ""
        if err:
            result += f"\nSTDERR: {err}"
        # Truncate very long output
        if len(result) > 3000:
            result = result[:3000] + "\n... (truncated)"
        return result or "(command produced no output)"
    except asyncio.TimeoutError:
        return "Command timed out after 15 seconds."
    except Exception as e:
        return f"Command error: {str(e)}"

llm_lock = asyncio.Lock()

async def process_llm_response(websocket: WebSocket, session_id: str, user_text: str, images: list = None):
    async with llm_lock:
        await _process_llm_response_locked(websocket, session_id, user_text, images)

async def _process_llm_response_locked(websocket: WebSocket, session_id: str, user_text: str, images: list = None):
    settings = load_settings()
    api_key = settings.get("api_key")
    main_model = settings.get("model", "google/gemma-2-9b-it:free")
    multimodal_model = settings.get("multimodal_model", "google/gemini-1.5-flash")
    heavy_thinker_model = settings.get("heavy_thinker_model", "google/gemini-pro-1.5")

    # Dynamic model selection
    if images:
        selected_model = multimodal_model
        print(f"DEBUG: Switching to multimodal model: {selected_model}")
        await broadcast_to_uis({"type": "response.model_switch", "model": selected_model, "reason": "multimodal"}, session_id=session_id)
    else:
        selected_model = main_model

    if not api_key:
        await websocket.send_json({
            "type": "response.ai_text.delta",
            "delta": "[Error: OpenRouter API Key not set. Please configure it in settings.]"
        })
        await websocket.send_json({"type": "response.ai_text.done", "text": "Error"})
        return
        
    log_text = user_text
    if images and not log_text.strip():
        log_text = "[Image Attached]"
    elif images:
        log_text = f"[Image Attached] {log_text}"
        
    # ONLY add to memory if it's not already the latest message in history
    # This avoids duplication between passive logging and interactive turns
    recent_check = memory.get_recent_messages(session_id, limit=1)
    if not recent_check or recent_check[0]["content"] != log_text:
        memory.add_message(session_id, "user", log_text)
    
    # Retrieve relevant history context
    relevant_facts = memory.search_memory(user_text, top_k=5)
    # ALSO explicitly search for location/identity facts to ensure they are always present
    identity_facts = memory.search_memory("user identity location residence history", top_k=3)
    
    unique_facts = list(set(relevant_facts + identity_facts))
    recent_messages = memory.get_recent_messages(session_id, limit=20)
    
    assistant_name = settings.get("assistant_name", "AI Assistant")
    base_prompt = settings.get("system_prompt", "You are a helpful AI.")
    durable_memories = memory.get_durable_memories()
    
    current_time = datetime.now().strftime("%A, %B %d, %Y at %I:%M %p")
    
    # Build a robust system prompt
    skills_list = get_available_skills()
    skills_summary = ""
    if skills_list:
        skills_summary = "AVAILABLE SPECIALIZED SKILLS:\n"
        for s in skills_list:
            skills_summary += f"- {s['id']}: {s['description']}\n"
        skills_summary += "If a task matches one of these skills, use 'get_skill_info' to read instructions first.\n\n"

    system_prompt = (
        f"You are {assistant_name}, the Sentience assistant. You live in the user's Linux status bar.\n"
        f"Current Time: {current_time}\n\n"
        "IDENTITY & VIBE:\n"
        "- BE CONCISE: Use minimal words. Avoid intros. If the user presents a valid alternative or correction, acknowledge it briefly with logic.\n"
        "- BE AGGRESSIVE: If a tool fails, re-try with the other tool automatically. (e.g., if get_weather fails, use web_search for 'weather in [location]').\n"
        "- US UNITS: ALWAYS use **Fahrenheit** and **Miles**. Strictly avoid Celsius or Kilometers. This is non-negotiable for the user's region.\n"
        "- CONCISE WEATHER: If the user asks for the weather, use 'get_weather' to report the current condition and temperature briefly.\n"
        "- NEVER GIVE UP: Don't tell the user 'I cannot pull live data'. That's a failure of your agentic logic. Solve it.\n"
        "- NO FILLER: Avoid useless follow-up questions. Just respond to the user's request.\n"
        "- NO LATEX: Direct markdown and emojis only.\n\n"
        "MANDATORY TOOL RULES:\n"
        "1. REAL-TIME: Always use tools for facts. Use 'web_search' for news/current events.\n"
        "2. WEATHER: Always try 'get_weather' first. If it fails, IMMEDIATELY use 'web_search' for weather snippets.\n"
        "3. MEMORY: Always use 'record_memory' for personal details. Don't ask, just do it.\n"
        "4. HISTORY: Use 'search_memory' for cross-session context.\n"
        "5. SUMMARIZE: After using any tool, you MUST provide a concise summary or answer based on the results. NEVER return an empty response after a tool has executed.\n\n"
        f"{skills_summary}"
        "GUIDELINES:\n"
        "- Use DURABLE MEMORY as your core truth."
    )
    
    if durable_memories:
        system_prompt += f"\n\n--- DURABLE MEMORY ---\n{durable_memories}\n"

    if relevant_facts:
        facts_str = "\n".join([f"- {f}" for f in unique_facts])
        system_prompt += f"\n\n--- RECENT SEMANTIC CONTEXT ---\n{facts_str}"
        
    system_prompt += "\n\n(Note: All tools are online. Do not speculate; execute.)"

    messages = [{"role": "system", "content": system_prompt}]
    
    # Process history and handle images
    for i, msg in enumerate(recent_messages):
        is_last = (i == len(recent_messages) - 1)
        role = msg["role"]
        content = msg["content"]
        
        # If this is the last message and we have active images, transform it into multimodal content
        if is_last and role == "user" and images:
            content_array = []
            if user_text:
                content_array.append({"type": "text", "text": user_text})
            else:
                # Fallback to the logged text if user_text is empty
                content_array.append({"type": "text", "text": content})
                
            for img_b64 in images:
                content_array.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}
                })
            messages.append({"role": "user", "content": content_array})
        else:
            messages.append({"role": role, "content": content})
    
    # Final check: if history was empty or didn't end with a user role (unlikely), add it now
    if not any(m["role"] == "user" for m in messages[-2:]):
        if images:
            content_array = [{"type": "text", "text": user_text}] if user_text else []
            for img_b64 in images:
                content_array.append({
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"}
                })
            messages.append({"role": "user", "content": content_array})
        else:
            messages.append({"role": "user", "content": user_text})

    client = AsyncOpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=api_key,
    )
    
    try:
        # Agentic loop: keep calling the LLM until it stops requesting tools
        max_iterations = 5
        for iteration in range(max_iterations):
            # Retry loop for rate limits
            for attempt in range(3):
                try:
                    response = await client.chat.completions.create(
                        model=selected_model,
                        messages=messages,
                        tools=TOOLS,
                        tool_choice="auto",
                        temperature=0,
                        stream=False,  # Revert for stability until loop is refactored
                        extra_headers={
                            "HTTP-Referer": "http://localhost:8345",
                            "X-Title": assistant_name
                        }
                    )
                    break  # Success
                except Exception as retry_err:
                    if "429" in str(retry_err) and attempt < 2:
                        wait_time = (attempt + 1) * 3
                        await websocket.send_json({
                            "type": "response.text.delta",
                            "delta": f"⏳ Rate limited, retrying in {wait_time}s...\n"
                        })
                        await asyncio.sleep(wait_time)
                    else:
                        raise
            
            choice = response.choices[0]
            
            # If the model wants to call tools
            if choice.finish_reason == "tool_calls" or (choice.message.tool_calls and len(choice.message.tool_calls) > 0):
                # Standardize the assistant message as a dictionary for OpenRouter
                tool_calls_json = []
                for tc in (choice.message.tool_calls or []):
                    tool_calls_json.append({
                        "id": tc.id,
                        "type": "function",
                        "function": {
                            "name": tc.function.name,
                            "arguments": tc.function.arguments
                        }
                    })
                
                messages.append({
                    "role": "assistant",
                    "content": choice.message.content or "",
                    "tool_calls": tool_calls_json
                })
                
                # Show "Thinking..." only to clients in this session
                await broadcast_to_uis({
                    "type": "response.ai_text.delta",
                    "delta": "💭 Thinking...\n\n"
                }, session_id=session_id)
                
                # Execute each tool call
                for tool_call in (choice.message.tool_calls or []):
                    fn_name = tool_call.function.name
                    fn_args = json.loads(tool_call.function.arguments)
                    
                    print(f"DEBUG: LLM requested tool {fn_name} args {fn_args}")
                    

                    
                    result = await execute_tool(fn_name, fn_args)

                    # Detect heavy thinker signal and switch model for subsequent calls
                    if isinstance(result, str) and result.startswith("__SWITCH_HEAVY_THINKER__"):
                        selected_model = heavy_thinker_model
                        reason = result.replace("__SWITCH_HEAVY_THINKER__: ", "")
                        print(f"DEBUG: Switching to heavy thinker model: {selected_model} ({reason})")
                        await broadcast_to_uis({"type": "response.model_switch", "model": selected_model, "reason": "heavy_thinker"}, session_id=session_id)
                    
                    # Gemini/OpenRouter logic: tool result must match tool_call_id
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": str(result)
                    })
                
                # Continue loop to process tool results
                continue
            
            # Final text response
            content = choice.message.content or ""
            print(f"DEBUG: Raw LLM Response (Iter {iteration}): '{content}'")
            
            # Refined LaTeX stripping: only remove if it looks like a Swarrow or specific common LaTeX artifacts
            import re
            content = content.replace("$", "")
            # Only strip specific backslash commands that are known to be problematic, instead of all \words
            content = re.sub(r'\\(swarrow|text|frac|sqrt|cdot|times|alpha|beta|gamma)', '', content)
            content = content.replace("\\", "").replace("{}", "")
            
            final_text = content.strip()
            print(f"DEBUG: Clean LLM Response: '{final_text}'")
            
            if not final_text:
                if iteration == 0:
                    final_text = "[The model didn't provide an answer or tool call. Try a different model.]"
                else:
                    # If we reached here after tool calls and it's still empty, it's a failure to summarize
                    final_text = "[Error: The model provided tool results but failed to summarize them. Please try again.]"
            
            await broadcast_to_uis({
                "type": "response.ai_text.done",
                "text": final_text
            }, session_id=session_id)
            
            memory.add_message(session_id, "assistant", final_text)

            # --- TTS Generation ---
            if 'tts_model' in globals() and tts_model is not None and final_text and settings.get("tts_enabled", True):
                try:
                    import re
                    # Strip emojis and *asterisks* (markdown) for smoother speech reading
                    clean_for_tts = re.sub(r'[*_#]', '', final_text)
                    clean_for_tts = re.sub(r':[a-z_]+:', '', clean_for_tts)
                    # Strip non-ascii simple fallback
                    clean_for_tts = re.sub(r'[^\x00-\x7F]+', ' ', clean_for_tts).strip()
                    
                    if clean_for_tts:
                        print("DEBUG: Generating TTS audio with Kokoro...")
                        # Run generator synchronously since we are at the end of the streaming text flow anyway.
                        # Using 'af_bella' as a good default female voice
                        generator = tts_model(
                            clean_for_tts, voice='af_bella',
                            speed=1.0, split_pattern=r'\n+'
                        )
                        import numpy as np
                        audio_chunks = []
                        for _, _, audio in generator:
                            audio_chunks.append(audio)
                        
                        if audio_chunks:
                            combined_audio = np.concatenate(audio_chunks)
                            with io.BytesIO() as wav_io:
                                sf.write(wav_io, combined_audio, 24000, format='WAV')
                                wav_bytes = wav_io.getvalue()
                                base64_audio = base64.b64encode(wav_bytes).decode('utf-8')
                                await broadcast_to_uis({
                                    "type": "response.audio.done",
                                    "audio": base64_audio
                                }, target_ws=websocket)
                        print("DEBUG: TTS Generation complete.")
                except Exception as tts_err:
                    print(f"Warning: TTS Generation failed: {tts_err}")

            return

        # Max iterations reached
        await websocket.send_json({
            "type": "response.ai_text.delta",
            "delta": "[Agent loop cap reached]"
        })
        await websocket.send_json({"type": "response.ai_text.done", "text": "Error"})
        
    except Exception as e:
        print("LLM Loop Error:", e)
        import traceback
        traceback.print_exc()
        await websocket.send_json({
            "type": "response.ai_text.delta",
            "delta": f"\n[LLM Error: {str(e)}]"
        })
        await websocket.send_json({"type": "response.ai_text.done", "text": "Error"})
    

async def run_inference(audio_data):
    if not audio_data:
        return ""
        
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tf:
        temp_path = tf.name
        
    try:
        async with inference_lock:
            with wave.open(temp_path, 'wb') as wf:
                wf.setnchannels(1)
                wf.setsampwidth(2)
                wf.setframerate(16000)
                wf.writeframes(audio_data)
            
            env = os.environ.copy()
            lib_path = os.path.join(SCRIPT_DIR, "sentience.cpp", "build")
            ggml_lib_path = os.path.join(lib_path, "ggml", "src")
            cuda_lib_path = os.path.join(ggml_lib_path, "ggml-cuda")
            env["LD_LIBRARY_PATH"] = f"{lib_path}:{ggml_lib_path}:{cuda_lib_path}:{env.get('LD_LIBRARY_PATH', '')}"
            
            # Use faster-whisper on GPU instead of the buggy C++ binary
            print(f"DEBUG: Running STT on GPU (Whisper)...")
            segments, info = stt_model.transcribe(temp_path, beam_size=1, language="en")
            res = " ".join([s.text for s in segments]).strip()
            
            # Filter common Whisper hallucinations from near-silence
            # We also ignore very tiny conversational filler if it's the only transcript
            hallucinations = ["thank you.", "thanks for watching!", "subtitles by", "---", "hello.", "hi.", "hey."]
            if res.lower() in hallucinations or len(res) <= 1:
                print(f"DEBUG: Filtered out noise/hallucination: '{res}'")
                return ""
                
            print(f"DEBUG: Inference result: '{res}'")
            return res
            # (Old logic below removed)
            process = None # dummy to keep structure for a moment if needed
            
            # Old processing removed.
            return res

        if err:
            print(f"DEBUG: voxtral stderr: {err}")
            with open("voxtral_error.log", "a") as f:
                f.write(f"--- {datetime.now()} ---\n{err}\n")

        lines = output.split('\n')
        clean_text = ""
        for line in lines:
            line = line.strip()
            if not line or line.startswith('voxtral_'):
                continue
            
            if line.startswith('[summary]') or line.startswith('[no-transcript]') or line.startswith('[tokens]'):
                continue
                
            # If the line looks like "[timestamp] text", extract the text
            if line.startswith('[') and ']' in line:
                parts = line.split(']', 1)
                if len(parts) > 1:
                    content = parts[1].strip()
                    if content:
                        clean_text += content + " "
            else:
                # Fallback: if it doesn't look like a log and doesn't have brackets, it might just be the raw text
                clean_text += line + " "
        
        res = clean_text.strip()
        print(f"DEBUG: Inference result: '{res}'")
        return res
        
    except Exception as e:
        print(f"DEBUG: Inference exception: {e}")
        import traceback
        traceback.print_exc()
        return ""
    finally:
        if os.path.exists(temp_path):
            os.remove(temp_path)

# Uvicorn run loop

from fastapi.staticfiles import StaticFiles
frontend_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "frontend", "dist")
if os.path.exists(frontend_path):
    app.mount("/", StaticFiles(directory=frontend_path, html=True), name="static")
else:
    print(f"Warning: frontend/dist not found at {frontend_path}.")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8345)
